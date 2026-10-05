import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, resume, status, accept } from '../lib/controller.mjs';
import { activeProcesses, delay, alive } from '../lib/recovery.mjs';
import { startRun, stopRun, jobStatus } from '../lib/background.mjs';
import { commandAudit, unfinishedCommands } from '../lib/audit.mjs';
import { bashAuditor } from '../lib/bash-audit.mjs';
import { execute } from '../lib/process.mjs';
import { installLauncher } from '../lib/launcher.mjs';

const read = file => JSON.parse(fs.readFileSync(file));
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
async function until(fn) { for (let i = 0; i < 200; i++) { const result = fn(); if (result) return result; await delay(25); } throw new Error('Condition not reached'); }
async function setup(t, scenario, maxAttempts = 2) {
  const f = await fixture({ scenario, maxRounds: 1 });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const profile = read(f.profile); profile.recovery = { maxAttempts, initialDelayMs: 10, maxDelayMs: 20 }; writeJSON(f.profile, profile);
  const state = await prepare(f.profile, f.task); await approve(f.profile, f.id, state.digest); return f;
}

test('transient Builder failure persists session immediately and retries in the same round', async t => {
  const f = await setup(t, 'network-builder-once');
  const result = await run(f.profile, f.id);
  assert.equal(result.status, 'ready_for_user', result.error); assert.equal(result.round, 1);
  const agents = lines(path.join(f.stateDir, 'mock-agents.jsonl'));
  assert.deepEqual(agents.map(x => [x.role, x.resumed]), [['builder', false], ['builder', true], ['reviewer', false]]);
  assert(fs.existsSync(path.join(f.stateDir, '1-builder-attempt-2.log')));
  assert(lines(path.join(f.stateDir, 'events.jsonl')).some(x => x.type === 'retry_wait'));
});

test('Reviewer outage retries only the checked review; gates and Builder are not repeated', async t => {
  const f = await setup(t, 'network-reviewer-once');
  const result = await run(f.profile, f.id); assert.equal(result.status, 'ready_for_user', result.error);
  const agents = lines(path.join(f.stateDir, 'mock-agents.jsonl'));
  assert.equal(agents.filter(x => x.role === 'builder').length, 1);
  assert.equal(agents.filter(x => x.role === 'reviewer').length, 2);
  assert(agents.filter(x => x.role === 'reviewer').every(x => !x.resumed));
  assert.equal(lines(path.join(f.stateDir, 'events.jsonl')).filter(x => x.type === 'check').length, 8);
});

test('retry budget pauses with a saved phase; explicit resume preserves the round', async t => {
  const f = await setup(t, 'network-builder-always');
  const paused = await run(f.profile, f.id);
  assert.equal(paused.status, 'paused_interrupted'); assert.equal(paused.interruption.phase, 'building');
  assert.equal(paused.builderSession, 'demo-builder-session'); assert.equal(paused.roundsThisCycle, 1);
  assert.equal(lines(path.join(f.stateDir, 'mock-agents.jsonl')).length, 2);
  const next = await resume(f.profile, f.id); assert.equal(next.status, 'building'); assert.equal(next.round, 1);
  assert.equal((await run(f.profile, f.id)).status, 'paused_interrupted');
});

test('hard controller death refuses a living orphan and later resumes its recorded Builder', async t => {
  const f = await setup(t, 'hang-builder-once');
  const child = spawn(process.execPath, ['cli.mjs', 'run', f.id, '--profile', f.profile], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await until(() => status(f.profile, f.id).builderSession);
  const worker = activeProcesses(f.stateDir).find(x => x.actor === 'builder'); assert(worker);
  child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
  await assert.rejects(resume(f.profile, f.id), /still running/);
  process.kill(-worker.pid, 'SIGKILL'); await until(() => !alive(worker));
  await resume(f.profile, f.id);
  const result = await run(f.profile, f.id); assert.equal(result.status, 'ready_for_user', result.error); assert.equal(result.round, 1);
  assert.equal(lines(path.join(f.stateDir, 'mock-agents.jsonl')).filter(x => x.role === 'builder')[1].resumed, true);
});

test('uncertain commands require human inspection and are never marked completed on recovery', async t => {
  const f = await setup(t, 'network-builder-always', 1); await run(f.profile, f.id);
  commandAudit({ root: path.join(f.commandCenter, '.opencode-loop-state'), stateDir: f.stateDir },
    { id: 'uncertain', phase: 'started', kind: 'dev_run', argv: ['python', 'probe.py'], cwd: f.feature });
  await assert.rejects(resume(f.profile, f.id), /Inspect unfinished commands/);
  await resume(f.profile, f.id, { acknowledgeUnknown: true });
  assert.equal(unfinishedCommands(f.stateDir).length, 0);
  const events = lines(path.join(f.stateDir, 'commands.jsonl')).filter(x => x.id === 'uncertain');
  assert.deepEqual(events.map(x => x.phase), ['started', 'reconciled']);
});

test('background runner completes independently and duplicate launches share one worker', async t => {
  const f = await setup(t, 'pass');
  const first = await startRun(f.profile, f.id); const again = await startRun(f.profile, f.id);
  assert.equal(first.token, again.token); assert.equal(first.alive, true);
  await until(() => !jobStatus(f.profile, f.id).alive);
  assert.equal(status(f.profile, f.id).status, 'ready_for_user');
  assert.equal(lines(path.join(f.stateDir, 'mock-agents.jsonl')).filter(x => x.role === 'builder').length, 1);
});

test('pausing a background runner terminates its worker and preserves resumable state', async t => {
  const f = await setup(t, 'hang-builder-once');
  await startRun(f.profile, f.id);
  await until(() => status(f.profile, f.id).builderSession);
  stopRun(f.profile, f.id);
  await until(() => !jobStatus(f.profile, f.id).alive);
  assert.equal(status(f.profile, f.id).status, 'paused_interrupted');
  assert.equal(activeProcesses(f.stateDir).length, 0);
  await resume(f.profile, f.id);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
});

test('changed files after an interrupted review invalidate checks without repeating Builder', async t => {
  const f = await setup(t, 'network-reviewer-once', 1);
  assert.equal((await run(f.profile, f.id)).status, 'paused_interrupted');
  fs.appendFileSync(path.join(f.feature, 'app/value.txt'), 'valid later edit\n');
  await resume(f.profile, f.id);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
  assert.equal(lines(path.join(f.stateDir, 'mock-agents.jsonl')).filter(x => x.role === 'builder').length, 1);
  assert.equal(lines(path.join(f.stateDir, 'events.jsonl')).filter(x => x.type === 'check').length, 16);
});

test('process and Bash audit preserve literal multiline commands, cwd, failure and duration', async t => {
  const f = await setup(t, 'pass');
  const ctx = { root: path.join(f.commandCenter, '.opencode-loop-state'), stateDir: f.stateDir, feature: f.id, cwd: f.feature };
  const bash = bashAuditor(ctx), input = { sessionID: 'session', callID: 'call', tool: 'bash' };
  const command = 'printf "first\\n"\nprintf "second\\n"';
  bash.before(input, { command }, 'builder'); bash.started({ ...input, cwd: f.feature }); bash.finish(input, { metadata: { exit: 7 } });
  await execute([process.execPath, '-e', 'process.exit(3)'], { cwd: f.feature, audit: { ...ctx, actor: 'controller', kind: 'check' } });
  const records = lines(path.join(f.stateDir, 'commands.jsonl'));
  assert.equal(records.find(x => x.kind === 'bash' && x.phase === 'finished').command, command);
  assert.equal(records.find(x => x.kind === 'bash' && x.phase === 'finished').exit_code, 7);
  assert.equal(records.find(x => x.kind === 'check' && x.phase === 'finished').exit_code, 3);
  assert.equal(unfinishedCommands(f.stateDir).length, 0);
  assert.equal(fs.statSync(path.join(f.stateDir, 'commands.jsonl')).mode & 0o777, 0o600);
});

test('launcher handles relocated paths with spaces and preserves custom scripts', async t => {
  const f = await setup(t, 'pass');
  const file = installLauncher(f.profile);
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.match(fs.readFileSync(file, 'utf8'), /exec node/);
  const syntax = await execute(['sh', '-n', file]); assert.equal(syntax.code, 0, syntax.err);
  fs.writeFileSync(file, '#!/bin/sh\necho custom\n'); assert.throws(() => installLauncher(f.profile), /preserved/);
});

test('acceptance is bound to the exact result displayed in the UI', async t => {
  const f = await setup(t, 'pass'); await run(f.profile, f.id);
  await assert.rejects(accept(f.profile, f.id, { expectedFingerprint: 'stale' }), /changed since confirmation/);
  await assert.rejects(accept(f.profile, f.id, { expectedDigest: 'stale' }), /changed since confirmation/);
});
