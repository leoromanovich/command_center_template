import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, feedback, accept, resolveUserAction, summary, status } from '../lib/controller.mjs';
import { requestUserAction, pendingUserAction, assertNoPendingUserAction, parseUserActionResponse, PENDING_ACTION } from '../lib/user-actions.mjs';
import { rolePermission } from '../lib/policy.mjs';
import { runDevCommand } from '../lib/dev-run.mjs';
import { execute } from '../lib/process.mjs';

const readJSON = file => JSON.parse(fs.readFileSync(file));
const events = f => fs.readFileSync(path.join(f.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const response = outcome => ({ outcome, summary: `User reports ${outcome}`, output: 'Human supplied diagnostic output; no command is executed by this test.' });
async function setup(t, scenario = 'user-action', configure = () => {}) {
  const f = await fixture({ scenario, maxRounds: 1 });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  configure(f);
  const state = await prepare(f.profile, f.task);
  await approve(f.profile, f.id, state.digest);
  return f;
}

for (const outcome of ['completed', 'failed', 'declined']) test(`manual ${outcome} resumes the same Builder session and preserves mandatory gates`, async t => {
  const f = await setup(t);
  const paused = await run(f.profile, f.id);
  assert.equal(paused.status, 'waiting_for_user_action', paused.error);
  const request = paused.pendingUserAction;
  assert.equal(request.request.commands[0].command, 'sudo --version');
  assert.equal(fs.existsSync(request.file), true);
  assert.match(fs.readFileSync(request.file, 'utf8'), /sudo --version/);
  assert.equal(events(f).filter(e => ['check', 'reviewer_started'].includes(e.type)).length, 0);
  assert.equal(fs.existsSync(path.join(f.feature, 'user-action-executed.txt')), false);
  assert.equal((await run(f.profile, f.id)).pendingUserAction.id, request.id);
  assert.equal(events(f).filter(e => e.type === 'builder_started').length, 1);
  assert.equal(summary(paused).pendingUserAction.id, request.id);
  const resumed = await resolveUserAction(f.profile, f.id, request.id, response(outcome));
  assert.equal(resumed.status, 'approved');
  assert.equal(resumed.resumeBuilder, true);
  assert.equal(resumed.roundsThisCycle, 1);
  assert.equal(pendingUserAction(f.stateDir), undefined);
  const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  assert.equal(ready.round, 1, 'A user pause must not consume another repair round');
  assert.equal(ready.userActions[0].response.outcome, outcome);
  assert.equal(events(f).filter(e => e.type === 'check').length, 8);
  const workers = fs.readFileSync(path.join(f.stateDir, 'mock-agents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(workers.map(w => [w.role, w.resumed]), [['builder', false], ['builder', true], ['reviewer', false]]);
  const resumedPrompt = fs.readFileSync(path.join(f.stateDir, '1-builder-resume-1-prompt.txt'), 'utf8');
  assert.match(resumedPrompt, new RegExp(`"outcome":"${outcome}"`));
  assert.equal(fs.existsSync(path.join(f.stateDir, '1-builder.log')), true);
  assert.equal(fs.existsSync(path.join(f.stateDir, '1-builder-resume-1.log')), true);
  assert.equal(fs.existsSync(path.join(f.feature, 'user-action-executed.txt')), false);
});

test('durable request survives a Builder crash and preserves its session for continuation', async t => {
  const f = await setup(t, 'user-action-crash');
  const paused = await run(f.profile, f.id);
  assert.equal(paused.status, 'waiting_for_user_action');
  assert.match(paused.pauseNotice, /builder failed/);
  assert.equal(paused.builderSession, 'demo-builder-session');
  await resolveUserAction(f.profile, f.id, paused.pendingUserAction.id, response('declined'));
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
});

test('pending requests cannot be skipped through feedback, plan replacement or acceptance', async t => {
  const f = await setup(t);
  const paused = await run(f.profile, f.id);
  await assert.rejects(feedback(f.profile, f.id, 'Skip the question'), /resolve-action/);
  await assert.rejects(accept(f.profile, f.id), /ready_for_user/);
  fs.appendFileSync(path.join(path.dirname(f.task), 'plan.md'), '\nNew plan scope.');
  await assert.rejects(prepare(f.profile, f.task, { replace: true }), /pending user action/);
  await assert.rejects(resolveUserAction(f.profile, f.id, 'wrong-id', response('completed')), /matching/);
  assert.equal(pendingUserAction(f.stateDir).id, paused.pendingUserAction.id);
});

test('a one-click response cannot acknowledge a request changed after its card was displayed', async t => {
  const f = await setup(t);
  const paused = await run(f.profile, f.id), packet = paused.pendingUserAction;
  const expectedRequest = structuredClone(packet.request);
  packet.request.commands[0].command = 'echo new command'; writeJSON(path.join(f.stateDir, PENDING_ACTION), packet);
  await assert.rejects(resolveUserAction(f.profile, f.id, packet.id, response('completed'), { expectedRequest }), /изменился/);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
});

test('manual responses are explicit and idempotent, including cleanup after a partial resolve', async t => {
  const f = await setup(t);
  const paused = await run(f.profile, f.id);
  const packet = paused.pendingUserAction;
  await assert.rejects(resolveUserAction(f.profile, f.id, packet.id, { outcome: 'completed', summary: 'Done' }), /requires/);
  const first = await resolveUserAction(f.profile, f.id, packet.id, response('failed'));
  const again = await resolveUserAction(f.profile, f.id, packet.id, response('failed'));
  assert.equal(first.userActions.length, 1);
  assert.equal(again.userActions.length, 1);
  await assert.rejects(resolveUserAction(f.profile, f.id, packet.id, response('completed')), /different/);
  writeJSON(path.join(f.stateDir, PENDING_ACTION), packet); // Crash after saved response, before unlink.
  assert.equal(pendingUserAction(f.stateDir), undefined);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
});

test('pending request blocks more Builder tools and dev_run before a reviewer is launched', async t => {
  const f = await setup(t);
  const paused = await run(f.profile, f.id);
  assert.throws(() => assertNoPendingUserAction(f.stateDir), /Waiting for user action/);
  paused.status = 'building'; // Simulate the interval before the controller consumes the tool result.
  writeJSON(path.join(f.stateDir, 'state.json'), paused);
  let reviews = 0;
  const result = await runDevCommand({}, { stateDir: f.stateDir, featureRoot: f.feature, round: 1, review: async () => { reviews++; } });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /Waiting for user action/);
  assert.equal(reviews, 0);
  const same = requestUserAction(paused.pendingUserAction.request, { stateDir: f.stateDir, featureRoot: f.feature, round: 1, sessionID: 'demo-builder-session' });
  assert.equal(same.id, paused.pendingUserAction.id);
  assert.throws(() => requestUserAction({ ...same.request, title: 'Another request' }, { stateDir: f.stateDir, featureRoot: f.feature, round: 1, sessionID: 'demo-builder-session' }), /already pending/);
});

test('CLI exposes waiting status and records a user response without executing proposed commands', async t => {
  const f = await setup(t);
  const cli = path.resolve('cli.mjs');
  const first = await execute([process.execPath, cli, 'run', f.id, '--profile', f.profile]);
  assert.equal(first.code, 3, first.err);
  const paused = JSON.parse(first.out);
  assert.equal(paused.status, 'waiting_for_user_action');
  const file = path.join(f.base, 'response.json');
  writeJSON(file, response('completed'));
  const resumed = await execute([process.execPath, cli, 'resolve-action', f.id, paused.pendingUserAction.id, file, '--profile', f.profile, '--run']);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(JSON.parse(resumed.out).status, 'ready_for_user');
  assert.equal(fs.existsSync(path.join(f.feature, 'user-action-executed.txt')), false);
});

test('role permissions expose proposal only; response schema rejects implicit or extra actions', () => {
  assert.equal(rolePermission('builder').request_user_action, 'allow');
  for (const role of ['planner', 'orchestrator', 'reviewer', 'execution-reviewer']) assert.notEqual(rolePermission(role).request_user_action, 'allow');
  assert.notEqual(rolePermission('builder').resolve_action, 'allow');
  for (const value of [null, { outcome: 'approved' }, { ...response('completed'), command: 'sudo anything' }, { ...response('failed'), output: 'x'.repeat(65537) }]) assert.throws(() => parseUserActionResponse(value));
});

test('status recovers a durable request even if the controller stopped before saving its pause', async t => {
  const f = await setup(t);
  const paused = await run(f.profile, f.id);
  const raw = readJSON(path.join(f.stateDir, 'state.json'));
  raw.status = 'building'; delete raw.pendingUserAction; delete raw.builderSession;
  writeJSON(path.join(f.stateDir, 'state.json'), raw);
  const visible = status(f.profile, f.id);
  assert.equal(visible.status, 'waiting_for_user_action');
  assert.equal(visible.pendingUserAction.id, paused.pendingUserAction.id);
  assert.equal(visible.builderSession, 'demo-builder-session');
  assert.equal((await run(f.profile, f.id)).status, 'waiting_for_user_action');
});
