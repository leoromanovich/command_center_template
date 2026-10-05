import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupDockerDemo } from '../setup-docker-demo.mjs';
import { attachExampleKnowledge } from '../setup-knowledge-project.mjs';
import { loadProfile, prepare, approve, run, accept, status } from '../../core/lib/controller.mjs';
import { previewKnowledge, decideKnowledge, runKnowledge, previewKnowledgePublication, publishKnowledge, startKnowledgeJob, knowledgeStatus, knowledgeWorkerState, feedbackKnowledge, retryKnowledgeCapture } from '../../core/lib/knowledge.mjs';
import { previewPublication, publishAccepted } from '../../core/lib/publication.mjs';
import { dockerExecute, stopDocker } from '../../core/lib/docker.mjs';
import { execute, git } from '../../core/lib/process.mjs';
import { roleTools } from '../lib/tools.mjs';
import { streams } from '../lib/events.mjs';

const dockerTest = process.env.CC_DOCKER_TEST === '1' ? test : test.skip;
async function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-knowledge-'));
  const f = await attachExampleKnowledge(await setupDockerDemo(path.join(parent, 'fixture')));
  const s = await prepare(f.profile, f.task); await approve(f.profile, f.id, s.digest);
  t.after(async () => {
    await stopDocker(f.stateDir); await stopDocker(path.join(f.stateDir, 'knowledge-update'));
    await execute(['docker', 'image', 'rm', s.snapshot.sandbox.retentionTag]);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return f;
}
const statePath = f => path.join(f.stateDir, 'state.json');
async function waitFor(f, predicate) {
  for (let i = 0; i < 600; i++) {
    const k = knowledgeStatus(f.stateDir); if (predicate(k)) return k;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Knowledge wait timed out: ' + JSON.stringify(knowledgeStatus(f.stateDir)?.job));
}

dockerTest('optional KB: propose → accept/publish code → approve selected update → Builder → KB + CC gitlink; delayed job survives code cleanup', { timeout: 180000 }, async t => {
  const f = await fixture(t), baseline = fs.readFileSync(path.join(f.knowledgeSource, 'docs/overview.md'), 'utf8');
  const reviewed = await run(f.profile, f.id); assert.equal(reviewed.status, 'ready_for_user', reviewed.error);
  const early = previewKnowledge(f.profile, f.id); assert.equal(early.status, 'awaiting_acceptance'); assert.equal(early.proposals.length, 1);
  await assert.rejects(decideKnowledge(f.profile, f.id, { ids: ['document-feature'] }), /недоступны/);
  const copyFile = fs.copyFileSync; let accepted;
  try {
    fs.copyFileSync = (source, destination, ...args) => {
      if (destination.startsWith(path.join(f.stateDir, 'knowledge-update/code/'))) throw new Error('Simulated evidence disk failure');
      return copyFile(source, destination, ...args);
    };
    accepted = await accept(f.profile, f.id, { expectedDigest: reviewed.digest, expectedFingerprint: reviewed.reviewedFingerprint });
  } finally { fs.copyFileSync = copyFile; }
  assert.equal(accepted.status, 'accepted', accepted.error);
  assert.equal(previewKnowledge(f.profile, f.id).status, 'capture_failed');
  await retryKnowledgeCapture(f.profile, f.id);
  let kb = previewKnowledge(f.profile, f.id); assert.equal(kb.status, 'proposed', kb.error);
  assert.equal(fs.readFileSync(path.join(f.knowledgeSource, 'docs/overview.md'), 'utf8'), baseline);
  const codePlan = await previewPublication(f.profile, f.id, { mode: 'commit' });
  assert.equal((await publishAccepted(f.profile, f.id, { expectedToken: codePlan.token, mode: 'commit', message: codePlan.message })).delivery.status, 'done');
  await decideKnowledge(f.profile, f.id, { expectedToken: kb.token, reject: true });
  assert.equal(status(f.profile, f.id).status, 'accepted');
  assert.equal(previewKnowledge(f.profile, f.id).status, 'rejected');
  await assert.rejects(decideKnowledge(f.profile, f.id, { expectedToken: 'stale', ids: ['document-feature'] }), /изменились/);
  await decideKnowledge(f.profile, f.id, { expectedToken: kb.token, ids: ['document-feature'] });
  // Accepted code was copied once. Its original feature worktrees can now be removed.
  for (const repo of accepted.snapshot.repos) await git(repo.source, 'worktree', 'remove', repo.root);
  const interrupted = await runKnowledge(f.profile, f.id, { signal: AbortSignal.abort() });
  assert.equal(interrupted.status, 'failed'); assert.equal(status(f.profile, f.id).status, 'accepted');
  // Exercise the final tool boundary with a valid KB-only execution snapshot.
  const folder = path.join(f.stateDir, 'knowledge-update'), kbState = path.join(folder, 'state.json');
  const running = { ...interrupted, status: 'running' };
  fs.writeFileSync(kbState, JSON.stringify(running));
  const context = knowledgeWorkerState(folder);
  const tools = await roleTools({ role: 'builder', knowledgeStage: true, root: context.snapshot.featureRoot,
    stateDir: folder, readRoots: [context.snapshot.featureRoot], profile: loadProfile(f.profile) });
  assert.deepEqual(tools.map(x => x.name).sort(), ['cc_edit', 'cc_find', 'cc_grep', 'cc_ls', 'cc_read', 'cc_write']);
  const write = args => tools.find(x => x.name === 'cc_write').execute('kb-boundary', args);
  await assert.rejects(write({ path: '/workspace/app/behavior.txt', content: 'bad' }), /outside/);
  await assert.rejects(write({ path: '/knowledge/docs/not-approved.md', content: 'bad' }), /not approved/);
  await assert.rejects(write({ path: '/knowledge/policy.txt', content: 'bad' }), /not approved/);
  await write({ path: '/knowledge/docs/overview.md', content: baseline });
  for (const target of ['/workspace/app/behavior.txt', '/knowledge/policy.txt']) {
    const attempt = await dockerExecute(context.snapshot, folder, ['sh', '-c', `echo bad > ${target}`], { role: 'builder', readonly: false });
    assert.notEqual(attempt.code, 0); assert.match(attempt.err, /read.only/i);
  }
  fs.writeFileSync(kbState, JSON.stringify({ ...running, approval: { ...running.approval, ids: ['unapproved'] } }));
  await assert.rejects(write({ path: '/knowledge/docs/overview.md', content: 'bad' }), /approval/);
  fs.writeFileSync(kbState, JSON.stringify(interrupted));
  await startKnowledgeJob(f.profile, f.id);
  kb = await waitFor(f, x => !x.job?.alive);
  assert.equal(kb.status, 'ready', kb.error ?? kb.job?.error);
  assert(kb.checks.every(x => x.passed)); assert.equal(kb.files.length, 1);
  assert(streams(f.stateDir).some(x => x.role === 'builder' && x.stage === 'knowledge'));
  assert.equal(status(f.profile, f.id).status, 'accepted');
  assert.match(kb.diff, /Reviewed feature/);
  await assert.rejects(feedbackKnowledge(f.profile, f.id, { fingerprint: 'stale', text: 'Fix docs' }), /изменился/);
  await feedbackKnowledge(f.profile, f.id, { fingerprint: kb.checkedFingerprint, text: 'Keep the existing title and concise wording.' });
  const resumed = await runKnowledge(f.profile, f.id);
  assert.equal(resumed.status, 'ready', resumed.error); assert.equal(resumed.session, kb.session);
  kb = resumed;
  let plan = await previewKnowledgePublication(f.profile, f.id);
  const file = path.join(kb.snapshot.knowledgeBase.root, 'docs/overview.md'), content = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, 'unreviewed\n');
  await assert.rejects(publishKnowledge(f.profile, f.id, { expectedToken: plan.token }), /изменилась/);
  fs.writeFileSync(file, content);
  plan = await previewKnowledgePublication(f.profile, f.id);
  const published = await publishKnowledge(f.profile, f.id, { expectedToken: plan.token });
  assert.equal(published.status, 'published', published.error);
  const heads = published.publication.records;
  assert.equal((await git(f.commandCenter, 'diff', '--name-only', kb.snapshot.knowledgeBase.ccBase, heads.cc.head)).trim(), 'knowledge');
  assert.match(await git(f.commandCenter, 'ls-tree', heads.cc.head, 'knowledge'), new RegExp('160000 commit ' + heads.kb.head));
  assert.equal((await git(f.commandCenter, 'rev-parse', 'HEAD')).trim(), kb.snapshot.knowledgeBase.ccBase);
  assert.equal((await git(f.knowledgeSource, 'rev-parse', 'HEAD')).trim(), kb.snapshot.knowledgeBase.base);
  assert.equal(fs.readFileSync(path.join(f.knowledgeSource, 'docs/overview.md'), 'utf8'), baseline);
  const again = await publishKnowledge(f.profile, f.id, { expectedToken: plan.token });
  assert.deepEqual(again.publication.records, heads);
  // Local commits can be pushed later. A failed CC push preserves the KB push and resumes without new commits.
  const profile = JSON.parse(fs.readFileSync(f.profile)); profile.git.allowPush = true;
  fs.writeFileSync(f.profile, JSON.stringify(profile));
  const remoteKB = path.join(f.base, 'remote-kb.git'), remoteCC = path.join(f.base, 'remote-cc.git');
  fs.mkdirSync(remoteKB); await git(remoteKB, 'init', '--bare');
  await git(f.knowledgeSource, 'remote', 'set-url', 'origin', remoteKB);
  await git(f.commandCenter, 'remote', 'add', 'origin', remoteCC);
  const pushPlan = await previewKnowledgePublication(f.profile, f.id, { mode: 'push' });
  assert.equal(pushPlan.done, false); assert.equal(pushPlan.mode, 'push');
  const partial = await publishKnowledge(f.profile, f.id, { mode: 'push', expectedToken: pushPlan.token });
  assert.equal(partial.status, 'publication_failed'); assert.equal(partial.publication.records.kb.status, 'pushed');
  assert.equal(status(f.profile, f.id).status, 'accepted');
  fs.mkdirSync(remoteCC); await git(remoteCC, 'init', '--bare');
  const retry = await publishKnowledge(f.profile, f.id, { mode: 'push', expectedToken: pushPlan.token });
  assert.equal(retry.status, 'published', retry.error);
  for (const target of pushPlan.targets) {
    assert.equal(retry.publication.records[target.kind].head, heads[target.kind].head);
    assert.equal((await git(target.url, 'rev-parse', `refs/heads/${target.branch}`)).trim(), heads[target.kind].head);
  }
});

dockerTest('knowledge Docker boundary: normal Builder sees KB RO and cannot propose escaped paths', { timeout: 60000 }, async t => {
  const f = await fixture(t), s = status(f.profile, f.id);
  s.status = 'building'; s.round = 1; fs.writeFileSync(statePath(f), JSON.stringify(s));
  const options = { role: 'builder', root: f.feature, readRoots: [f.feature], stateDir: f.stateDir, profile: loadProfile(f.profile) };
  const builder = await roleTools(options);
  const invoke = (tools, name, args) => tools.find(x => x.name === name).execute('test', args);
  assert.match(JSON.stringify(await invoke(builder, 'cc_read', { path: '/knowledge/docs/overview.md' })), /Project knowledge/);
  await assert.rejects(invoke(builder, 'cc_write', { path: '/knowledge/docs/overview.md', content: 'bad' }), /outside|read.only/i);
  await assert.rejects(invoke(builder, 'cc_exec', { cwd: 'app', argv: ['sh', '-c', 'echo bad > /knowledge/docs/overview.md'], reason: 'Try write' }), /read.only/i);
  await assert.rejects(invoke(builder, 'kb_propose', { proposals: [{ id: 'bad', title: 'bad', paths: ['../escape.md'], reason: 'bad', evidence: 'bad' }] }), /explicit/);
  await assert.rejects(invoke(builder, 'cc_read', { path: '/knowledge/../etc/passwd' }), /escapes/);
  assert.equal(fs.readFileSync(path.join(f.knowledgeSource, 'policy.txt'), 'utf8'), 'This file is outside the permitted documentation directory.\n');
});
