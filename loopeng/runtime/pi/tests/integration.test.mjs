import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupDemo } from '../setup-demo.mjs';
import { loadProfile, prepare, approve, run, resume, status, feedback, accept, resolveUserAction } from '../../core/lib/controller.mjs';
import { loadHumanReview } from '../../core/lib/human-review.mjs';
import { previewUserCommand, runUserCommand } from '../../core/lib/user-terminal.mjs';
import { execute } from '../../core/lib/process.mjs';
import { startRun, stopRun, jobStatus } from '../../core/lib/background.mjs';
import { activeProcesses } from '../../core/lib/recovery.mjs';
import { roleTools } from '../lib/tools.mjs';
import { jsonLines, streams } from '../lib/events.mjs';
import { createUsageReader, summarizeUsage } from '../lib/usage.mjs';

async function setup(t, scenario = 'loop') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cc-test-'));
  const f = await setupDemo(path.join(parent, 'fixture'), scenario);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const s = await prepare(f.profile, f.task); await approve(f.profile, f.id, s.digest);
  return f;
}
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out');
}

test('real pi SDK: Explorer → request → resume same session → failed lint → reviewer repair → human feedback and acceptance', async t => {
  const f = await setup(t);
  let s = await run(f.profile, f.id);
  assert.equal(s.status, 'waiting_for_user_action', s.error);
  const originalSession = s.builderSession, packet = s.pendingUserAction;
  assert.equal(s.round, 1);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'checks.json')), false);
  const preview = previewUserCommand(f.profile, f.id, packet.id, 0);
  assert.equal(preview.command, 'node --version');
  assert.equal(preview.resolvedCwd, path.join(f.feature, 'app'));
  const result = await runUserCommand(f.profile, f.id, preview, async (p, cb) => {
    const r = await execute([p.shell, '-c', p.command], { cwd: p.resolvedCwd, onSpawn: cb.onSpawn });
    cb.onExit(r); return r;
  });
  assert.equal(result.exit_code, 0);
  await assert.rejects(runUserCommand(f.profile, f.id, preview, () => { throw new Error('Must not repeat'); }), /changed|изменились/);
  await resolveUserAction(f.profile, f.id, packet.id, { outcome: 'completed', summary: 'Test executed the exact requested command', output: 'exit 0' });
  s = await run(f.profile, f.id); assert.equal(s.status, 'ready_for_user', s.error); assert.equal(s.round, 3);
  const all = streams(f.stateDir), builders = all.filter(x => x.role === 'builder');
  assert(builders.filter(x => x.events[0].sessionID === originalSession).length >= 2);
  assert(all.some(x => x.role === 'explorer' && x.parent === originalSession));
  assert(all.some(x => x.events.some(e => e.type === 'thinking_delta')));
  assert(all.some(x => x.role === 'reviewer'));
  const usage = createUsageReader(loadProfile(f.profile))(), totals = summarizeUsage(usage.records, usage.prices, f.id);
  assert(totals.responses > 10);
  assert.deepEqual(totals.roles.map(x => x.name).sort(), ['builder', 'explorer', 'reviewer']);
  assert.equal(totals.total, 0, 'scripted provider does not bill tokens');
  assert.equal(totals.cost, 0);
  const events = jsonLines(path.join(f.stateDir, 'events.jsonl'));
  assert(events.some(x => x.type === 'check' && x.phase === 'lint' && !x.passed));
  const review = await loadHumanReview(f.profile, f.id);
  assert.equal(review.canAccept, true); assert.equal(review.files.length, 2);
  await assert.rejects(accept(f.profile, f.id, { expectedDigest: 'stale', expectedFingerprint: review.fingerprint }), /changed/);
  await feedback(f.profile, f.id, 'Keep both values valid and reviewed.', { expectedDigest: review.digest, expectedFingerprint: review.fingerprint });
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
  const revised = await loadHumanReview(f.profile, f.id);
  assert.equal((await accept(f.profile, f.id, { expectedDigest: revised.digest, expectedFingerprint: revised.fingerprint })).status, 'accepted');
  assert.equal(fs.readFileSync(path.join(f.base, 'sources/app/value.txt'), 'utf8'), 'original\n');
  assert(jsonLines(path.join(f.stateDir, 'commands.jsonl')).some(x => x.kind === 'user_command' && x.phase === 'finished' && x.exit_code === 0));
});

test('pi provider network failure resumes saved Builder context; Reviewer outage keeps checked changes', async t => {
  for (const role of ['builder', 'reviewer']) {
    const f = await setup(t, `network-${role}-once`);
    const paused = await run(f.profile, f.id); assert.equal(paused.status, 'paused_interrupted');
    const first = paused.builderSession;
    await resume(f.profile, f.id);
    const done = await run(f.profile, f.id); assert.equal(done.status, 'ready_for_user', done.error); assert.equal(done.round, 1);
    if (role === 'builder') assert.equal(done.builderSession, first);
    else assert.equal(jsonLines(path.join(f.stateDir, 'events.jsonl')).filter(x => x.type === 'check').length, 8);
  }
});

test('background pi run has one owner, stops safely and resumes independently of the UI', async t => {
  const f = await setup(t, 'no-action');
  const first = await startRun(f.profile, f.id), duplicate = await startRun(f.profile, f.id);
  assert.equal(first.token, duplicate.token);
  await until(() => status(f.profile, f.id).builderSession);
  stopRun(f.profile, f.id);
  await until(() => !jobStatus(f.profile, f.id)?.alive);
  assert.equal(activeProcesses(f.stateDir).length, 0);
  assert.equal(status(f.profile, f.id).status, 'paused_interrupted');
  await resume(f.profile, f.id);
  await startRun(f.profile, f.id);
  await until(() => !jobStatus(f.profile, f.id)?.alive);
  assert.equal(status(f.profile, f.id).status, 'ready_for_user');
});

test('role executors enforce scope after tool argument mutation and exclude execution from Explorer/Reviewer', async t => {
  const f = await setup(t, 'no-action'), profile = loadProfile(f.profile);
  const s = status(f.profile, f.id); s.status = 'building'; s.round = 1; fs.writeFileSync(path.join(f.stateDir, 'state.json'), JSON.stringify(s));
  const make = role => roleTools({ role, root: f.feature, readRoots: [f.feature], stateDir: f.stateDir, profile, sessionID: () => 'test-session' });
  const builder = await make('builder'), explorer = await make('explorer'), reviewer = await make('reviewer');
  const invoke = (tools, name, args) => tools.find(x => x.name === name).execute('call', args);
  assert(!explorer.some(x => ['cc_write', 'cc_edit', 'dev_run', 'explore', 'request_user_action', 'bash'].includes(x.name)));
  assert(!reviewer.some(x => ['cc_write', 'cc_edit', 'dev_run', 'explore', 'bash'].includes(x.name)));
  fs.symlinkSync(f.commandCenter, path.join(f.feature, 'escape'));
  await assert.rejects(invoke(builder, 'cc_write', { path: 'escape/no.txt', content: 'bad' }), /outside/);
  await assert.rejects(invoke(builder, 'cc_write', { path: 'app/.git/config', content: 'bad' }));
  await assert.rejects(invoke(explorer, 'cc_read', { path: 'escape/AGENTS.md' }), /outside/);
  fs.writeFileSync(path.join(f.feature, 'app/.env'), 'unique-secret-marker');
  await assert.rejects(invoke(explorer, 'cc_read', { path: 'app/.env' }), /secrets/);
  const search = await invoke(explorer, 'cc_grep', { path: '.', pattern: 'unique-secret-marker' });
  assert(!search.content[0].text.includes('unique-secret-marker'));
  await assert.rejects(invoke(builder, 'cc_git', { cwd: path.join(f.feature, 'app'), args: ['commit', '-am', 'bad'] }));
  const read = await invoke(explorer, 'cc_git', { cwd: path.join(f.feature, 'app'), args: ['status', '--short'] });
  assert(read.content);
});

test('dev_run uses the real pi Execution Reviewer and a denied verdict never executes the script', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cc-exec-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const f = await setupDemo(path.join(parent, 'fixture'), 'no-action');
  const raw = JSON.parse(fs.readFileSync(f.profile));
  raw.devRun = { enabled: true };
  raw.repositories.app.devCommands = { node: { kind: 'script', description: 'Diagnostic script', argv: [process.execPath], extensions: ['.mjs'] } };
  fs.writeFileSync(f.profile, JSON.stringify(raw));
  fs.writeFileSync(path.join(f.feature, 'app/probe.mjs'), 'import fs from "node:fs";fs.writeFileSync("must-not-exist", "bad");');
  const prepared = await prepare(f.profile, f.task); await approve(f.profile, f.id, prepared.digest);
  const s = status(f.profile, f.id); s.status = 'building'; s.round = 1; fs.writeFileSync(path.join(f.stateDir, 'state.json'), JSON.stringify(s));
  const tools = await roleTools({ role: 'builder', root: f.feature, readRoots: [f.feature], stateDir: f.stateDir, profile: loadProfile(f.profile) });
  const result = await tools.find(x => x.name === 'dev_run').execute('test', { repo: 'app', command: 'node', target: 'probe.mjs', reason: 'Check current behavior', expected: 'Diagnostics output' });
  assert.match(JSON.stringify(result), /denied|deny/);
  assert.equal(fs.existsSync(path.join(f.feature, 'app/must-not-exist')), false);
  assert(streams(f.stateDir).some(x => x.role === 'execution-reviewer' && x.last.type === 'finished'));
});
