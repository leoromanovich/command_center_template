import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from '../demo/fixture.mjs';
import { prepare } from '../lib/controller.mjs';
import { processTracker, atomicJSON } from '../lib/recovery.mjs';
import { taskActivity, readTaskActivity, readInteractiveActivity, workspaceSummary, createWorkspaceMonitor } from '../lib/workspace-status.mjs';

const task = (status, extra = {}) => ({ id: 'feature', status, round: 2, ...extra });
const apiFor = (directory, { statuses = {}, questions = [], permissions = [], sessions = {}, fail = false } = {}) => {
  const read = data => async args => { assert.equal(args.directory, directory); if (fail) throw new Error('offline'); return { data }; };
  return { client: { session: { status: read(statuses), get: async args => ({ data: sessions[args.sessionID] }) },
    question: { list: read(questions) }, permission: { list: read(permissions) } },
  state: { session: { get: id => sessions[id], messages: () => [] } } };
};

test('dashboard distinguishes agents, commands and checks; finished phases need user review', () => {
  const row = taskActivity(task('building', { job: { alive: true } }), [
    { kind: 'agent_launch', actor: 'builder', pid: 101 },
    { kind: 'execution-reviewer', actor: 'execution-reviewer', pid: 102 },
    { kind: 'dev_run', actor: 'builder', pid: 103 },
  ]);
  assert.equal(row.agents.length, 2); assert.equal(row.running, true); assert.equal(row.attention, false);
  assert.match(row.activity, /Builder \+ Execution Reviewer \+ dev_run/);
  const checks = taskActivity(task('checking'), [{ kind: 'check', actor: 'controller', pid: 104 }]);
  assert.equal(checks.agents.length, 0); assert.equal(checks.running, true); assert.equal(checks.activity, 'Проверки');
  const ready = taskActivity(task('ready_for_user'));
  assert.equal(ready.attention, true); assert.equal(ready.target, 'review');
  assert.equal(taskActivity(task('prepared')).target, 'approve');
});

test('stale building state and retry backoff do not invent a live agent', () => {
  const stopped = taskActivity(task('building'));
  assert.equal(stopped.running, false); assert.equal(stopped.attention, true); assert.equal(stopped.target, 'resume');
  assert.equal(stopped.activity, 'Прервано');
  const retry = taskActivity(task('building', { job: { alive: true }, nextRetryAt: '2099-01-01T00:00:00Z' }));
  assert.equal(retry.agents.length, 0); assert.equal(retry.attention, false); assert.match(retry.activity, /повтор/);
  assert.equal(taskActivity(task('committing_reviewed')).target, 'menu', 'Special recovery uses its existing Git action');
});

test('pending requests remain visible; accepted tasks leave the compact panel', () => {
  const pending = taskActivity(task('waiting_for_user_action', { pendingUserAction: { request: { title: 'Install tool' } } }));
  assert.equal(pending.target, 'request'); assert.equal(pending.detail, 'Install tool');
  const running = taskActivity({ ...task('reviewing'), id: 'second', job: { alive: true } });
  const result = workspaceSummary([running, taskActivity(task('accepted')), pending]);
  assert.deepEqual(result.active.map(row => row.id), ['feature', 'second']);
  assert.equal(result.attention, 1); assert.equal(result.rows.length, 3);
});

test('process records reflect actual liveness, including a child that exited without an onClose update', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill()); await once(child, 'spawn');
  const tracker = processTracker(f.stateDir, { actor: 'builder', kind: 'agent_launch' }); tracker.onSpawn(child.pid);
  const tasks = [{ ...task('building'), id: f.id }];
  assert.equal(readTaskActivity(f.profile, tasks)[0].agents[0].pid, child.pid);
  const exit = once(child, 'exit'); child.kill(); await exit;
  const row = readTaskActivity(f.profile, tasks)[0];
  assert.equal(row.running, false); assert.equal(row.target, 'resume'); assert.equal(row.agents.length, 0);
  fs.writeFileSync(path.join(f.stateDir, 'processes', 'broken.json'), '{');
  const partial = readTaskActivity(f.profile, [...tasks, { ...task('prepared'), id: 'unaffected' }]);
  assert.equal(partial[0].activity, 'Данные недоступны'); assert.equal(partial[0].attention, true);
  assert.equal(partial[1].target, 'approve');
});

test('interactive status includes questions and permissions, scoped to this Command Center', async () => {
  const directory = '/tmp/control-center';
  const api = apiFor(directory, {
    statuses: { planner: { type: 'busy' }, jira: { type: 'retry', message: 'network timeout' }, idle: { type: 'idle' }, other: { type: 'busy' } },
    questions: [{ sessionID: 'planner' }, { sessionID: 'waiting' }], permissions: [{ sessionID: 'planner' }],
    sessions: { planner: { directory, title: 'Plan images', agent: 'planner' }, jira: { directory, title: 'Ticket', agent: 'jira' },
      waiting: { directory, title: 'Waiting question', agent: 'planner' }, other: { directory: '/tmp/another', title: 'Other', agent: 'builder' } },
  });
  const rows = await readInteractiveActivity(api, directory);
  assert.deepEqual(rows.map(row => row.id), ['planner', 'jira', 'waiting']);
  assert.match(rows[0].activity, /Planner · вопросов: 1, разрешений: 1/);
  assert.equal(rows[0].target, 'session'); assert.equal(rows[0].attention, true);
  assert.equal(rows[1].attention, false); assert.equal(rows[1].detail, 'network timeout');
  assert.equal(rows[2].attention, true); assert.equal(rows[2].running, false);
});

test('monitor updates after task changes and reports API failure without hiding local requests', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task);
  const monitor = createWorkspaceMonitor(f.profile, apiFor(f.commandCenter, { fail: true }));
  const seen = []; const unsubscribe = monitor.subscribe(value => seen.push(value));
  await monitor.refresh();
  assert.equal(monitor.getSnapshot().active[0].target, 'approve'); assert.match(monitor.getSnapshot().warnings[0], /offline/);
  const file = path.join(f.stateDir, 'state.json'), state = JSON.parse(fs.readFileSync(file));
  state.status = 'ready_for_user'; atomicJSON(file, state); await monitor.refresh();
  assert.equal(monitor.getSnapshot().active[0].target, 'review'); assert.equal(seen.length, 3);
  unsubscribe(); await monitor.refresh(); assert.equal(seen.length, 3); monitor.dispose();
});

test('monitor shares in-flight refresh and cannot publish after disposal', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  let complete; const api = apiFor(f.commandCenter);
  api.client.session.status = () => new Promise(resolve => { complete = resolve; });
  const monitor = createWorkspaceMonitor(f.profile, api); let updates = 0;
  monitor.subscribe(() => updates++);
  const first = monitor.refresh([]); assert.equal(monitor.refresh([]), first);
  monitor.dispose(); complete({ data: {} }); await first;
  assert.equal(updates, 1); assert.equal(monitor.refresh([]), undefined);
});
