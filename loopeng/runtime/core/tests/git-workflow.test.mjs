import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, resume, status, feedback, accept, fingerprint, commitReviewed, previewBase, refreshBase } from '../lib/controller.mjs';
import { git } from '../lib/process.mjs';
import { publishGit, gitPublication } from '../lib/git-workflow.mjs';

test('legacy feature publication requires an exact configured branch and rejects protected names and malformed lists', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const profile = { git: { allowCommit: true }, repositories: { app: { baseRef: 'main', git: { allowedBranches: ['demo-feature'] } } } };
  const repo = { id: 'app', root: path.join(f.feature, 'app'), branch: 'demo-feature' };
  assert.equal((await gitPublication(profile, { publication: { commit: true } }, [repo])).targets[0].branch, 'demo-feature');
  profile.repositories.app.git.allowedBranches = 'demo-feature';
  await assert.rejects(gitPublication(profile, { publication: { commit: true } }, [repo]), /array of literal/);
  profile.repositories.app.git.allowedBranches = ['main']; repo.branch = 'main';
  await assert.rejects(gitPublication(profile, { publication: { commit: true } }, [repo]), /Protected/);
});

async function setup(t, { push = false, clone = false, scenario = 'pass' } = {}) {
  const f = await fixture({ scenario });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const profile = JSON.parse(fs.readFileSync(f.profile)), task = JSON.parse(fs.readFileSync(f.task));
  for (const [id, repo] of Object.entries(profile.repositories)) {
    await git(repo.source, 'worktree', 'remove', path.join(f.feature, id));
    await git(repo.source, 'branch', '-d', f.id);
    repo.baseRef = 'main'; repo.git = { remote: 'origin' };
    if (push || clone) {
      const remote = path.join(f.base, `${id}.git`);
      await git(f.base, 'clone', '--bare', '--', repo.source, remote);
      await git(repo.source, 'remote', 'add', 'origin', remote);
      if (clone) { repo.cloneUrl = remote; repo.source = path.join(f.base, 'cloned', id); }
    }
  }
  profile.workspace = { autoCreate: true, cloneMissing: clone };
  profile.git = { allowCommit: true, allowPush: push };
  profile.worktreeParent = 'WorkTree';
  f.feature = path.join(f.commandCenter, 'WorkTree', f.id);
  await git(f.commandCenter, 'init', '-b', 'main');
  task.worktrees = Object.fromEntries(task.repositories.map(id => [id, { base: 'main', branch: `feature/${f.id}` }]));
  task.publication = { commit: true, push };
  writeJSON(f.profile, profile); writeJSON(f.task, task);
  return { ...f, profileData: profile, taskData: task };
}
async function approved(f) { const s = await prepare(f.profile, f.task); await approve(f.profile, f.id, s.digest); return s; }

test('prepare provisions multiple nested ignored worktrees and never changes source checkout', async t => {
  const f = await setup(t);
  const s = await prepare(f.profile, f.task);
  assert.equal(s.status, 'prepared');
  for (const repo of s.snapshot.repos) {
    assert.equal(repo.branch, `feature/${f.id}`);
    assert.equal((await git(repo.source, 'branch', '--show-current')).trim(), 'main');
    assert.equal((await git(repo.root, 'show', 'HEAD:value.txt')).trim(), 'original');
  }
  await git(f.commandCenter, 'check-ignore', '--', `WorkTree/${f.id}/app/value.txt`);
  await git(f.commandCenter, 'add', '--all');
  assert.doesNotMatch(await git(f.commandCenter, 'ls-files'), /WorkTree|opencode-loop-state/);
  assert.equal((await prepare(f.profile, f.task)).digest, s.digest);
  assert.match(fs.readFileSync(path.join(f.profileData.stateRoot ?? path.join(f.commandCenter, '.opencode-loop-state'), 'commands.log'), 'utf8'), /worktree/);
});

test('configured local source clones are reused and fetch/checkouts preserve the source', async t => {
  const f = await setup(t, { clone: true });
  for (const entry of Object.values(f.taskData.worktrees)) { entry.base = 'origin/main'; entry.fetch = true; }
  f.taskData.publication = {}; writeJSON(f.task, f.taskData);
  const s = await prepare(f.profile, f.task);
  assert.equal(s.snapshot.repos.length, 2);
  assert.equal((await prepare(f.profile, f.task)).digest, s.digest);
  const entries = fs.readFileSync(path.join(f.commandCenter, '.opencode-loop-state/commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(e => e.phase === 'started' && e.argv.includes('clone')).length, 2);
});

test('provisioning rejects protected branches, symlinks, tracked workspaces and conflicting branch reuse', async t => {
  const f = await setup(t);
  f.taskData.worktrees.app.branch = 'main'; writeJSON(f.task, f.taskData);
  await assert.rejects(prepare(f.profile, f.task), /feature branch/);
  f.taskData.worktrees.app.branch = `feature/${f.id}`; writeJSON(f.task, f.taskData);
  fs.mkdirSync(path.join(f.commandCenter, 'WorkTree'), { recursive: true });
  fs.writeFileSync(path.join(f.commandCenter, 'WorkTree/tracked.txt'), 'user data');
  await git(f.commandCenter, 'add', '--', 'WorkTree/tracked.txt');
  await assert.rejects(prepare(f.profile, f.task), /already tracked/);
  await git(f.commandCenter, 'rm', '--cached', '--', 'WorkTree/tracked.txt');
  fs.symlinkSync(f.base, f.feature);
  await assert.rejects(prepare(f.profile, f.task), /symlink/);
  fs.unlinkSync(f.feature);
  await git(f.profileData.repositories.app.source, 'branch', `feature/${f.id}`);
  await assert.rejects(prepare(f.profile, f.task), /reuseBranch/);
  f.taskData.worktrees.app.reuseBranch = true; writeJSON(f.task, f.taskData);
  assert.equal((await prepare(f.profile, f.task)).status, 'prepared');
});

test('Git policy requires profile permission and pins one remote in the approved plan', async t => {
  const f = await setup(t, { push: true });
  f.profileData.git.allowPush = false; writeJSON(f.profile, f.profileData);
  await assert.rejects(prepare(f.profile, f.task), /allowPush/);
  f.profileData.git.allowPush = true; writeJSON(f.profile, f.profileData);
  const s = await approved(f);
  await git(s.snapshot.repos[0].root, 'remote', 'set-url', 'origin', path.join(f.base, 'different.git'));
  const paused = await run(f.profile, f.id);
  assert.equal(paused.status, 'paused_interrupted');
  assert.match(paused.error, /remote URL changed/);
});

test('reviewed commits/push affect feature refs only, remain idempotent and allow another cycle', async t => {
  const f = await setup(t, { push: true, scenario: 'loop' });
  const s = await approved(f);
  const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  assert.equal(ready.round, 3);
  for (const repo of ready.snapshot.repos) {
    assert.equal((await git(repo.source, 'rev-parse', 'HEAD')).trim(), repo.base);
    assert.equal((await git(repo.root, 'rev-list', '--count', `${repo.base}..HEAD`)).trim(), '1');
    const remote = path.join(f.base, `${repo.id}.git`);
    assert.equal((await git(remote, 'rev-parse', 'main')).trim(), repo.base);
    assert.equal((await git(remote, 'rev-parse', repo.branch)).trim(), ready.publishedHeads[repo.id]);
    assert.equal((await git(repo.root, 'status', '--porcelain')).trim(), '');
  }
  assert.equal((await run(f.profile, f.id)).round, 3);
  await feedback(f.profile, f.id, 'Check once more within the approved scope');
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
  assert.equal((await accept(f.profile, f.id)).status, 'accepted');
  assert.equal(s.snapshot.publication.git.push, true);
});

test('unavailable push resumes publication without duplicate commits or rerunning Builder', async t => {
  const f = await setup(t, { push: true }); await approved(f);
  const remote = path.join(f.base, 'app.git'); fs.renameSync(remote, `${remote}.offline`);
  const paused = await run(f.profile, f.id);
  assert.equal(paused.status, 'paused_interrupted', paused.error);
  assert.equal(paused.interruption.phase, 'publishing');
  const count = fs.readFileSync(path.join(f.stateDir, 'mock-agents.jsonl'), 'utf8');
  fs.renameSync(`${remote}.offline`, remote);
  await resume(f.profile, f.id);
  const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'mock-agents.jsonl'), 'utf8'), count);
  assert.equal((await git(path.join(f.feature, 'app'), 'rev-list', '--count', `${ready.snapshot.repos[0].base}..HEAD`)).trim(), '1');
});

test('interruption after branch update reconciles saved commit intent', async t => {
  const f = await setup(t); const initial = await approved(f);
  // First get checked/reviewed files without publishing, then restore the approved Git spec in memory.
  initial.status = 'publishing'; initial.gitPublication = {}; initial.publishedHeads = {};
  for (const repo of initial.snapshot.repos) fs.writeFileSync(path.join(repo.root, 'value.txt'), 'valid\n');
  initial.reviewedFingerprint = await fingerprint(initial.snapshot);
  let checkpoint;
  const save = (_dir, value) => {
    checkpoint = structuredClone(value);
    if (value.gitPublication.app?.status === 'committed') throw new Error('Simulated controller crash');
  };
  await assert.rejects(publishGit(f.stateDir, initial, { save, fingerprint }), /Simulated/);
  // Disk had the commit_created intent when the ref moved, but not the subsequent save.
  checkpoint.gitPublication.app.status = 'commit_created'; delete checkpoint.publishedHeads.app;
  await publishGit(f.stateDir, checkpoint, { save() {}, fingerprint });
  assert.equal((await git(path.join(f.feature, 'app'), 'rev-list', '--count', `${initial.snapshot.repos[0].base}..HEAD`)).trim(), '1');
});

test('a divergent remote feature branch is never overwritten', async t => {
  const f = await setup(t, { push: true }); const initial = await approved(f);
  const remote = path.join(f.base, 'app.git'), source = initial.snapshot.repos[0].source;
  const tree = (await git(source, 'rev-parse', 'HEAD^{tree}')).trim();
  const other = (await git(source, 'commit-tree', tree, '-p', initial.snapshot.repos[0].base, '-m', 'Someone else changed the remote')).trim();
  await git(source, 'push', remote, `${other}:refs/heads/feature/${f.id}`);
  const result = await run(f.profile, f.id);
  assert.equal(result.status, 'paused_interrupted');
  assert.equal((await git(remote, 'rev-parse', `feature/${f.id}`)).trim(), other);
  assert.match(result.error, /rejected|fetch first|non-fast-forward/);
});

test('Git normalization cannot silently publish bytes that were not reviewed', async t => {
  const f = await setup(t); const initial = await approved(f), root = initial.snapshot.repos[0].root;
  fs.writeFileSync(path.join(root, '.gitattributes'), 'value.txt text eol=lf\n');
  fs.writeFileSync(path.join(root, 'value.txt'), 'valid\r\n');
  initial.reviewedFingerprint = await fingerprint(initial.snapshot);
  await assert.rejects(publishGit(f.stateDir, initial, { save() {}, fingerprint }), /changes reviewed bytes/);
  assert.equal((await git(root, 'rev-parse', 'HEAD')).trim(), initial.snapshot.repos[0].base);
});

async function legacy(t) {
  const f = await setup(t);
  f.taskData.publication = {}; delete f.profileData.git;
  writeJSON(f.profile, f.profileData); writeJSON(f.task, f.taskData);
  await approved(f); const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  delete ready.checkedFingerprint; delete ready.checkResults;
  writeJSON(path.join(f.stateDir, 'state.json'), ready);
  f.profileData.git = { allowCommit: true, allowPush: true }; writeJSON(f.profile, f.profileData);
  return { ...f, ready, confirmation: { expectedDigest: ready.digest, expectedFingerprint: ready.reviewedFingerprint } };
}
async function dependent(f) {
  const task = { ...f.taskData, id: 'dependent', worktrees: Object.fromEntries(f.taskData.repositories.map(id =>
    [id, { base: `feature/${f.id}`, branch: 'feature/dependent' }])) };
  const file = path.join(path.dirname(f.task), 'dependent.json'); writeJSON(file, task);
  return prepare(f.profile, file);
}
const baseConfirmation = preview => ({ expectedDigest: preview.digest, expectedTargets: preview.targets });

test('legacy reviewed result commits locally without changing approval, acceptance, files or agent count', async t => {
  const f = await legacy(t), agents = fs.readFileSync(path.join(f.stateDir, 'mock-agents.jsonl'), 'utf8');
  const result = await commitReviewed(f.profile, f.id, f.confirmation);
  assert.equal(result.status, 'ready_for_user', result.error);
  assert.deepEqual(result.snapshot, f.ready.snapshot); assert.deepEqual(result.approved, f.ready.approved);
  assert.equal(result.acceptedAt, undefined); assert.equal(result.digest, f.ready.digest);
  assert.equal(result.reviewedCommit.status, 'done'); assert.equal(result.reviewedCommit.spec.push, false);
  assert.equal(await fingerprint(result.snapshot), f.ready.reviewedFingerprint);
  for (const repo of result.snapshot.repos) {
    assert.notEqual(result.publishedHeads[repo.id], repo.base);
    assert.equal((await git(repo.source, 'rev-parse', 'main')).trim(), repo.base);
    assert.equal((await git(repo.root, 'status', '--porcelain')).trim(), '');
  }
  assert.deepEqual((await commitReviewed(f.profile, f.id, f.confirmation)).publishedHeads, result.publishedHeads);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'mock-agents.jsonl'), 'utf8'), agents);
  assert(!fs.readFileSync(path.join(f.stateDir, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).some(x => x.argv?.includes('push')));
});

test('reviewed commit refuses stale confirmations, changed files and missing current permission', async t => {
  const f = await legacy(t);
  await assert.rejects(commitReviewed(f.profile, f.id, { ...f.confirmation, expectedDigest: 'stale' }), /confirmation/);
  delete f.profileData.git; writeJSON(f.profile, f.profileData);
  await assert.rejects(commitReviewed(f.profile, f.id, f.confirmation), /allowCommit/);
  f.profileData.git = { allowCommit: true }; writeJSON(f.profile, f.profileData);
  const evidenceFile = path.join(f.stateDir, 'result.json'), evidence = JSON.parse(fs.readFileSync(evidenceFile));
  writeJSON(evidenceFile, { ...evidence, checks: evidence.checks.slice(1) });
  await assert.rejects(commitReviewed(f.profile, f.id, f.confirmation), /every approved command/);
  writeJSON(evidenceFile, evidence);
  const file = path.join(f.feature, 'app/value.txt'); fs.appendFileSync(file, 'unreviewed');
  await assert.rejects(commitReviewed(f.profile, f.id, f.confirmation), /changed since review/);
  assert.equal((await git(path.dirname(file), 'rev-parse', 'HEAD')).trim(), f.ready.snapshot.repos[0].base);
});

test('dependent base refresh advances all clean worktrees and requires a new approval', async t => {
  const f = await legacy(t), initial = await dependent(f);
  await approve(f.profile, 'dependent', initial.digest);
  const committed = await commitReviewed(f.profile, f.id, f.confirmation);
  const preview = await previewBase(f.profile, 'dependent'); assert.equal(preview.changed, true);
  const result = await refreshBase(f.profile, 'dependent', baseConfirmation(preview));
  assert.equal(result.status, 'prepared', result.error); assert.equal(result.approved, undefined); assert.equal(result.round, 0);
  assert.notEqual(result.digest, initial.digest);
  assert.equal(result.baseRefresh.oldDigest, initial.digest);
  for (const repo of result.snapshot.repos) {
    assert.equal(repo.base, committed.publishedHeads[repo.id]);
    assert.equal(await git(repo.root, 'show', 'HEAD:value.txt'), await git(repo.source, 'show', `${committed.publishedHeads[repo.id]}:value.txt`));
  }
  await assert.rejects(run(f.profile, 'dependent'), /Approve/);
  await assert.rejects(approve(f.profile, 'dependent', initial.digest), /exact prepared digest/);
  assert.equal((await previewBase(f.profile, 'dependent')).changed, false);
});

test('base preflight rejects stale targets, dirty/ignored files, local commits and started tasks before any mutation', async t => {
  const f = await legacy(t), initial = await dependent(f), [app, library] = initial.snapshot.repos;
  const oldPreview = await previewBase(f.profile, 'dependent');
  await commitReviewed(f.profile, f.id, f.confirmation);
  await assert.rejects(refreshBase(f.profile, 'dependent', baseConfirmation(oldPreview)), /changed since preview/);
  const preview = await previewBase(f.profile, 'dependent');
  for (const name of ['value.txt', 'new.txt', 'build/cache']) {
    const file = path.join(library.root, name), saved = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'user work');
    await assert.rejects(refreshBase(f.profile, 'dependent', baseConfirmation(preview)), /must be clean/);
    assert.equal((await git(app.root, 'rev-parse', 'HEAD')).trim(), app.base);
    if (saved) fs.writeFileSync(file, saved); else fs.unlinkSync(file);
  }
  const tree = (await git(library.root, 'rev-parse', 'HEAD^{tree}')).trim();
  const own = (await git(library.root, 'commit-tree', tree, '-p', library.base, '-m', 'local change')).trim();
  await git(library.root, 'update-ref', `refs/heads/${library.branch}`, own, library.base);
  await assert.rejects(previewBase(f.profile, 'dependent'), /local commits/);
  assert.equal((await git(app.root, 'rev-parse', 'HEAD')).trim(), app.base);
  await assert.rejects(previewBase(f.profile, f.id), /never-started/);
});

test('partial commit and base refresh recover pinned intent without replaying Builder or following a moved base', async t => {
  const f = await legacy(t), initial = await dependent(f);
  // Simulate a crash after one ref moved, before publishedHeads was saved.
  const interrupted = structuredClone(f.ready);
  interrupted.status = 'committing_reviewed';
  interrupted.reviewedCommit = { status: 'started', digest: f.ready.digest, fingerprint: f.ready.reviewedFingerprint,
    returnStatus: 'ready_for_user', spec: { commit: true, push: false, targets: f.ready.snapshot.repos.map(r => ({ repo: r.id, branch: r.branch })) } };
  let saved;
  await assert.rejects(publishGit(f.stateDir, interrupted, { spec: interrupted.reviewedCommit.spec, fingerprint,
    save(_dir, value) {
      if (value.gitPublication.app?.status === 'committed') throw new Error('Crash after CAS');
      saved = structuredClone(value);
    } }), /Crash/);
  writeJSON(path.join(f.stateDir, 'state.json'), saved);
  await assert.rejects(run(f.profile, f.id), /pending Git/);
  const ready = await commitReviewed(f.profile, f.id, f.confirmation);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  const preview = await previewBase(f.profile, 'dependent'), first = initial.snapshot.repos[0];
  const dir = path.join(f.commandCenter, '.opencode-loop-state/dependent');
  initial.status = 'refreshing_base'; initial.baseRefresh = { status: 'started', oldDigest: initial.digest, targets: preview.targets };
  writeJSON(path.join(dir, 'state.json'), initial);
  await git(first.root, 'merge', '--ff-only', preview.targets[0].to);
  // Upstream gets another commit after the original human approval. Recovery still uses its saved SHA.
  const source = f.ready.snapshot.repos[0], tree = (await git(source.root, 'rev-parse', 'HEAD^{tree}')).trim();
  const later = (await git(source.root, 'commit-tree', tree, '-p', ready.publishedHeads.app, '-m', 'later upstream')).trim();
  await git(source.root, 'update-ref', `refs/heads/${source.branch}`, later, ready.publishedHeads.app);
  assert.deepEqual(await previewBase(f.profile, 'dependent'), preview);
  const result = await refreshBase(f.profile, 'dependent', baseConfirmation(preview));
  assert.equal(result.status, 'prepared', result.error);
  assert.equal(result.snapshot.repos[0].base, ready.publishedHeads.app);
  assert.equal((await git(first.root, 'rev-list', '--count', `${first.base}..HEAD`)).trim(), '1');
});
