// Native request/pause/resume integration test. Proposed sudo commands are never executed.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture, writeJSON } from './fixture.mjs';
import { prepare, approve, run, status } from '../lib/controller.mjs';
import { execute } from '../lib/process.mjs';

if (!process.argv.includes('--real')) throw new Error('Pass --real to authorize model calls in a fresh test fixture');
const option = process.argv.indexOf('--profile');
if (option < 0) throw new Error('--profile /absolute/path/profile.local.json is required');
const configured = JSON.parse(fs.readFileSync(path.resolve(process.argv[option + 1]), 'utf8'));
const f = await fixture({ scenario: 'pass', maxRounds: 2 });
console.log(JSON.stringify({ fixture: f.base, stateDir: f.stateDir }));
const profile = JSON.parse(fs.readFileSync(f.profile));
Object.assign(profile, { opencode: configured.opencode, models: configured.models, reasoningEffort: configured.reasoningEffort,
  disabledMcp: configured.disabledMcp, timeoutSeconds: 300 });
writeJSON(f.profile, profile);
fs.writeFileSync(path.join(path.dirname(f.task), 'plan.md'), `# User action protocol acceptance test

This is a tiny local test of requesting manual host work and resuming. First, before editing files, Builder MUST call request_user_action for repo app with exactly one proposed command: sudo --version, cwd ${f.feature}. Explain that the protocol test requires a user response and Builder is not allowed to run sudo. Do not execute that command yourself. After the successful request stop tools and finish.

The test harness will supply an explicitly simulated declined response; no sudo operation is needed or authorized for this test. On receiving that response, continue unprivileged and write app/value.txt as valid app followed by a newline, and library/value.txt as valid library followed by a newline. This user response satisfies the protocol prerequisite. The commands must remain unexecuted. No further requests, code execution, publishing, dependencies, or unrelated files are needed. The controller will run all format/lint/tests and Reviewer.
`);
const task = JSON.parse(fs.readFileSync(f.task));
task.acceptance = ['The loop pauses for request_user_action before checks.', 'After the simulated declined response the same Builder session resumes.', 'App and library values are valid and all controller checks pass.', 'No proposed sudo command is executed.'];
writeJSON(f.task, task);
const prepared = await prepare(f.profile, f.task);
await approve(f.profile, f.id, prepared.digest);
const paused = await run(f.profile, f.id);
assert.equal(paused.status, 'waiting_for_user_action', paused.error);
assert.equal(paused.pendingUserAction.request.commands.length, 1);
assert.equal(paused.pendingUserAction.request.commands[0].command, 'sudo --version');
const before = fs.readFileSync(path.join(f.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(before.filter(event => ['check', 'reviewer_started'].includes(event.type)).length, 0);
const session = paused.builderSession;
console.log(JSON.stringify({ case: 'native-pause', passed: true, request_id: paused.pendingUserAction.id, session }));
const responseFile = path.join(f.base, 'response.json');
writeJSON(responseFile, { outcome: 'declined', summary: 'Simulated user refusal for this integration test; continue unprivileged as planned.', output: 'No sudo command was run. The protocol prerequisite is satisfied by this explicit test response.' });
const result = await execute([process.execPath, path.resolve('cli.mjs'), 'resolve-action', f.id, paused.pendingUserAction.id, responseFile, '--profile', f.profile, '--run'],
  { timeout: 600, log: path.join(f.base, 'resolve-action.log') });
assert.equal(result.code, 0, result.out + result.err);
const ready = status(f.profile, f.id);
assert.equal(ready.status, 'ready_for_user', ready.error);
assert.equal(ready.builderSession, session);
assert.equal(ready.round, 1);
assert.equal(ready.userActions[0].response.outcome, 'declined');
for (const file of fs.readdirSync(f.stateDir).filter(name => /builder.*\.log$/.test(name))) {
  for (const line of fs.readFileSync(path.join(f.stateDir, file), 'utf8').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'tool_use' && event.part?.tool === 'bash') assert(!event.part.state.input.command.includes('sudo'), 'A proposed sudo command was sent to bash');
  }
}
writeJSON(path.join(f.base, 'smoke-result.json'), { at: new Date().toISOString(), model: profile.models.builder,
  status: ready.status, request_id: paused.pendingUserAction.id, session, round: ready.round,
  outcome: ready.userActions[0].response.outcome, proposed_commands_executed: false, stateDir: f.stateDir });
console.log(JSON.stringify({ case: 'native-resume', passed: true, status: ready.status, session, round: ready.round, report: path.join(f.base, 'smoke-result.json') }));
