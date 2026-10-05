import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupDemo } from '../setup-demo.mjs';
import { prepare, approve, run, status, accept } from '../../core/lib/controller.mjs';
import { previewPublication, publishAccepted, reconcilePublication, previewCleanup, cleanupAccepted } from '../../core/lib/publication.mjs';
import { git, execute } from '../../core/lib/process.mjs';
import { startRun, jobStatus } from '../../core/lib/background.mjs';

async function setup(t, { failMR = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publish-test-'));
  const f = await setupDemo(path.join(temp, 'fixture'), 'no-action');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const profile = JSON.parse(fs.readFileSync(f.profile)), task = JSON.parse(fs.readFileSync(f.task));
  profile.git.allowPush = true;
  for (const [id, repo] of Object.entries(profile.repositories)) {
    const remote = path.join(f.base, `${id}.git`);
    await git(f.base, 'clone', '--bare', '--', repo.source, remote);
    await git(repo.source, 'remote', 'add', 'origin', remote);
  }
  const hook = path.join(f.commandCenter, 'mr.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';import path from 'node:path';
const dir=path.dirname(process.env.CC_RESULT_PATH), file=path.join(dir,'fake-mr-count');
const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;
fs.writeFileSync(file,String(n+1));
if (${failMR} && n===0) process.exit(1);
console.log(JSON.stringify({id:'123',url:'https://example.invalid/merge_requests/123'}));`);
  profile.hooks = { mergeRequest: [process.execPath, hook] };
  task.publication = { commit: true, push: true, mergeRequest: true };
  fs.writeFileSync(f.profile, JSON.stringify(profile)); fs.writeFileSync(f.task, JSON.stringify(task));
  const prepared = await prepare(f.profile, f.task); await approve(f.profile, f.id, prepared.digest);
  const ready = await run(f.profile, f.id); assert.equal(ready.status, 'ready_for_user', ready.error);
  assert.equal(ready.gitPublication, undefined);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'fake-mr-count')), false);
  return f;
}
async function accepted(f) {
  const s = status(f.profile, f.id);
  return accept(f.profile, f.id, { expectedDigest: s.digest, expectedFingerprint: s.reviewedFingerprint });
}
const options = p => ({ expectedToken: p.token, mode: p.mode, message: p.message });

test('accepted result: preview binds files/message/remote, local commit then push/MR reuse the commit, cleanup requires merge', { timeout: 120000 }, async t => {
  const f = await setup(t);
  await assert.rejects(previewPublication(f.profile, f.id), /Сначала примите/);
  await accepted(f);
  const p = await previewPublication(f.profile, f.id, { mode: 'commit', message: "Add user's category totals" });
  assert.equal(p.repositories.length, 2); assert(p.repositories.every(x => x.files.some(f => f.name === 'value.txt')));
  const file = path.join(f.feature, 'app/value.txt'), text = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, 'changed');
  await assert.rejects(publishAccepted(f.profile, f.id, options(p)), /изменились после приёмки/);
  fs.writeFileSync(file, text);
  await assert.rejects(publishAccepted(f.profile, f.id, { ...options(p), message: 'not displayed' }), /изменилась после просмотра/);
  const committed = await publishAccepted(f.profile, f.id, options(p));
  assert.equal(committed.delivery.status, 'done', committed.error);
  const heads = { ...committed.publishedHeads };
  for (const repo of committed.snapshot.repos) {
    assert.equal((await git(repo.root, 'log', '-1', '--format=%B')).trimEnd(), p.spec.messages[repo.id]);
    assert.equal((await git(repo.source, 'show', 'main:value.txt')).trim(), 'original');
  }
  const complete = await previewPublication(f.profile, f.id);
  assert(complete.done); assert.equal(complete.canEditMessage, false);
  await publishAccepted(f.profile, f.id, options(complete));
  const push = await previewPublication(f.profile, f.id, { mode: 'push' });
  const repo = committed.snapshot.repos[0], oldURL = (await git(repo.source, 'remote', 'get-url', 'origin')).trim();
  await git(repo.source, 'remote', 'set-url', 'origin', oldURL + '-changed');
  await assert.rejects(publishAccepted(f.profile, f.id, options(push)), /изменилась|Изменились/);
  await git(repo.source, 'remote', 'set-url', 'origin', oldURL);
  await startRun(f.profile, f.id, { action: 'publish-accepted', ...options(push) });
  for (let i = 0; i < 300 && jobStatus(f.profile, f.id)?.alive; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(jobStatus(f.profile, f.id).status, 'finished');
  assert.deepEqual(status(f.profile, f.id).publishedHeads, heads);
  for (const repo of committed.snapshot.repos) assert.equal((await git(path.join(f.base, `${repo.id}.git`), 'rev-parse', `refs/heads/${repo.branch}`)).trim(), heads[repo.id]);
  const mr = await previewPublication(f.profile, f.id, { mode: 'mr' });
  const published = await publishAccepted(f.profile, f.id, options(mr));
  assert.equal(published.delivery.status, 'done', published.error);
  assert.equal(published.hookResults.mergeRequest.url, 'https://example.invalid/merge_requests/123');
  await publishAccepted(f.profile, f.id, options(mr));
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'fake-mr-count'), 'utf8'), '1');
  await assert.rejects(previewCleanup(f.profile, f.id), /ещё не входит/);
  for (const repo of published.snapshot.repos) await git(repo.source, 'merge', '--ff-only', repo.branch);
  const ignored = path.join(f.feature, 'app/build'); fs.mkdirSync(ignored); fs.writeFileSync(path.join(ignored, 'keep'), 'user data');
  await assert.rejects(previewCleanup(f.profile, f.id), /ignored/);
  fs.rmSync(ignored, { recursive: true });
  const cleanup = await previewCleanup(f.profile, f.id);
  await assert.rejects(cleanupAccepted(f.profile, f.id, { expectedToken: 'stale' }), /изменились после просмотра/);
  const cleaned = await cleanupAccepted(f.profile, f.id, { expectedToken: cleanup.token });
  assert.equal(cleaned.workspaceCleanup.status, 'done', cleaned.error);
  for (const repo of cleaned.snapshot.repos) {
    assert(!fs.existsSync(repo.root));
    assert.equal((await git(repo.source, 'rev-parse', repo.branch)).trim(), heads[repo.id]);
  }
  assert.match(fs.readFileSync(path.join(f.stateDir, 'changes.diff'), 'utf8'), /value.txt/);
});

test('interrupted multi-repository commit resumes the pinned message and never recommits completed repositories', { timeout: 60000 }, async t => {
  const f = await setup(t); const s = await accepted(f);
  const p = await previewPublication(f.profile, f.id, { mode: 'commit', message: 'One reviewed change' });
  const repo = s.snapshot.repos[1], lock = path.resolve(repo.root, (await git(repo.root, 'rev-parse', '--git-path', 'index.lock')).trim());
  fs.writeFileSync(lock, 'injected lock');
  const interrupted = await publishAccepted(f.profile, f.id, options(p));
  assert.equal(interrupted.delivery.status, 'pending'); assert.match(interrupted.error, /Git add failed/);
  const head = interrupted.publishedHeads.app;
  fs.rmSync(lock);
  const retry = await previewPublication(f.profile, f.id);
  assert(retry.pending); assert.equal(retry.token, p.token);
  const done = await publishAccepted(f.profile, f.id, options(retry));
  assert.equal(done.delivery.status, 'done', done.error); assert.equal(done.publishedHeads.app, head);
});

test('uncertain MR cannot run twice; explicit resource reconciliation resumes publication', { timeout: 60000 }, async t => {
  const f = await setup(t, { failMR: true }); await accepted(f);
  const p = await previewPublication(f.profile, f.id, { mode: 'mr' });
  const failed = await publishAccepted(f.profile, f.id, options(p));
  assert.equal(failed.delivery.status, 'pending'); assert.equal(failed.hookResults.mergeRequest.status, 'started');
  await assert.rejects(publishAccepted(f.profile, f.id, options(p)), /Исход MR/);
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'fake-mr-count'), 'utf8'), '1');
  await reconcilePublication(f.profile, f.id, { expectedToken: p.token, applied: true, resourceID: '123', url: 'https://example.invalid/merge_requests/123' });
  const done = await publishAccepted(f.profile, f.id, options(p));
  assert.equal(done.delivery.status, 'done', done.error);
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'fake-mr-count'), 'utf8'), '1');
});
