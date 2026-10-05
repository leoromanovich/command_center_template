import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, status, resolveUserAction } from '../lib/controller.mjs';
import { previewUserCommand, runUserCommand, userCommandRuns } from '../lib/user-terminal.mjs';
import { PENDING_ACTION } from '../lib/user-actions.mjs';
import { atomicJSON, processTracker } from '../lib/recovery.mjs';
import { execute } from '../lib/process.mjs';

const response = { outcome: 'completed', summary: 'Checked by the user', output: '' };
async function setup(t) {
  const f = await fixture({ scenario: 'user-action' });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const prepared = await prepare(f.profile, f.task);
  await approve(f.profile, f.id, prepared.digest);
  const waiting = await run(f.profile, f.id);
  return { ...f, request: waiting.pendingUserAction };
}
const preview = f => previewUserCommand(f.profile, f.id, f.request.id, 1);

test('human command executes in the displayed cwd, audits its outcome and leaves Builder paused', async t => {
  const f = await setup(t), command = preview(f);
  const result = await runUserCommand(f.profile, f.id, command, (item, hooks) =>
    execute([item.shell, '-c', item.command], { cwd: item.resolvedCwd, ...hooks }));
  assert.equal(result.exit_code, 0);
  assert.equal(fs.existsSync(path.join(f.feature, 'user-action-executed.txt')), true);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
  assert.equal(userCommandRuns(f.profile, f.id, f.request.id).length, 1);
  const entries = fs.readFileSync(path.join(f.stateDir, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.kind === 'user_command');
  assert.deepEqual(entries.map(e => [e.actor, e.phase]), [['user', 'started'], ['user', 'finished']]);
  assert.equal(entries[1].command, command.command); assert.equal(entries[1].cwd, command.resolvedCwd);
  assert.equal(entries[1].exit_code, 0); assert.equal(entries[1].output, undefined); assert.equal(entries[1].env, undefined);
  let executions = 0;
  await assert.rejects(runUserCommand(f.profile, f.id, command, async () => { executions++; return { code: 0 }; }), /изменились/);
  assert.equal(executions, 0, 'A repeated click cannot reuse a consumed confirmation');
  await resolveUserAction(f.profile, f.id, f.request.id, response);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
});

test('editing a request or replacing its cwd symlink invalidates displayed confirmation', async t => {
  const f = await setup(t), file = path.join(f.stateDir, PENDING_ACTION);
  const link = path.join(f.base, 'command-cwd'); fs.symlinkSync(f.feature, link);
  f.request.request.commands[1].cwd = link; writeJSON(file, f.request);
  const shown = preview(f);
  fs.unlinkSync(link); fs.symlinkSync(f.commandCenter, link);
  let executions = 0;
  const execute = async () => { executions++; return { code: 0 }; };
  await assert.rejects(runUserCommand(f.profile, f.id, shown, execute), /изменились/);
  const shownAgain = preview(f);
  f.request.request.commands[1].command = 'echo changed'; writeJSON(file, f.request);
  await assert.rejects(runUserCommand(f.profile, f.id, shownAgain, execute), /изменились/);
  assert.equal(executions, 0);
});

test('concurrent response and command execution are serialized by the controller lease', async t => {
  const f = await setup(t), shown = preview(f);
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  const running = runUserCommand(f.profile, f.id, shown, () => new Promise(resolve => { finish = resolve; started(); }));
  await entered;
  try {
    await assert.rejects(resolveUserAction(f.profile, f.id, f.request.id, response), /busy/);
    await assert.rejects(runUserCommand(f.profile, f.id, preview(f), async () => ({ code: 0 })), /busy/);
    await assert.rejects(run(f.profile, f.id), /busy/);
  } finally { finish({ code: 7 }); await running; }
  assert.equal(userCommandRuns(f.profile, f.id, f.request.id)[0].exit_code, 7);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
});

test('live orphan human command prevents both another execution and resolving the request', async t => {
  const f = await setup(t), tracker = processTracker(f.stateDir, { actor: 'user', kind: 'user_command' });
  tracker.onSpawn(process.pid);
  try {
    await assert.rejects(runUserCommand(f.profile, f.id, preview(f), async () => ({ code: 0 })), /still running/);
    await assert.rejects(resolveUserAction(f.profile, f.id, f.request.id, response), /still running/);
  } finally { tracker.onClose({ code: 0 }); }
});

test('command outcome is durable before returning from terminal output inspection', async t => {
  const f = await setup(t);
  let finishReading, exited;
  const saved = new Promise(resolve => { exited = resolve; });
  const running = runUserCommand(f.profile, f.id, preview(f), async (command, hooks) => {
    hooks.onExit({ code: 0 }); exited();
    await new Promise(resolve => { finishReading = resolve; });
    throw new Error('UI restore failed after the command finished');
  });
  await saved;
  try {
    const runs = userCommandRuns(f.profile, f.id, f.request.id);
    assert.equal(runs[0].status, 'finished'); assert.equal(runs[0].exit_code, 0);
    await assert.rejects(resolveUserAction(f.profile, f.id, f.request.id, response), /busy/);
  } finally { finishReading(); }
  const result = await running;
  assert.equal(result.exit_code, 0); assert.equal(result.error, undefined);
});

test('unknown outcome survives reload and errors/signals never become success or auto-resume', async t => {
  const f = await setup(t), shown = preview(f);
  const history = path.join(f.stateDir, 'user-actions', f.request.id, 'terminal-runs.json');
  atomicJSON(history, [{ id: 'interrupted-attempt', index: 1, status: 'running', started: new Date().toISOString() }]);
  await assert.rejects(runUserCommand(f.profile, f.id, shown, async () => ({ code: 0 })), /изменились/);
  assert.equal(preview(f).previous[0].status, 'running');
  const cancelled = await runUserCommand(f.profile, f.id, preview(f), async () => ({ code: null, signal: 'SIGINT' }));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.exit_code, null);
  const failed = await runUserCommand(f.profile, f.id, preview(f), async () => { throw new Error('No interactive terminal'); });
  assert.equal(failed.status, 'error'); assert.equal(failed.exit_code, null);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
  await resolveUserAction(f.profile, f.id, f.request.id, response);
  assert.throws(() => preview(f), /закрыт/);
});
