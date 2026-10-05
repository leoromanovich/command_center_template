import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, parseToolSubmission } from '../lib/controller.mjs';
import { devRunSettings, resolveDevCommands, parseExecutionReview, runDevCommand } from '../lib/dev-run.mjs';
import { rolePermission } from '../lib/policy.mjs';

const source = "import fs from 'node:fs'; fs.writeFileSync('executed.txt', 'yes'); console.log('diagnostic passed');";
const input = { repo: 'app', command: 'node', target: 'probe.mjs', reason: 'Verify app values from the approved plan', expected: 'App diagnostic passes' };
const verdict = (request, extra = {}) => ({ request_id: request.request_id, verdict: 'allow', task_relevant: true, risk: 'low', reason: 'Local task diagnostic', evidence: ['Inspected probe.mjs'], ...extra });

async function setup(t, settings = {}, script = source, configure = () => {}) {
  const f = await fixture({ scenario: 'pass' });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const profile = JSON.parse(fs.readFileSync(f.profile));
  profile.devRun = { enabled: true, ...settings };
  profile.repositories.app.devCommands = { node: { kind: 'script', description: 'App diagnostic', argv: [process.execPath], extensions: ['.mjs'] } };
  configure(profile, f);
  writeJSON(f.profile, profile);
  fs.writeFileSync(path.join(f.feature, 'app/probe.mjs'), script);
  const prepared = await prepare(f.profile, f.task);
  const state = await approve(f.profile, f.id, prepared.digest);
  state.status = 'building'; state.round = 1;
  writeJSON(path.join(f.stateDir, 'state.json'), state);
  const options = { stateDir: f.stateDir, featureRoot: f.feature, round: 1, review: async (_state, request) => verdict(request) };
  return { ...f, options, marker: path.join(f.feature, 'app/executed.txt'), script: path.join(f.feature, 'app/probe.mjs') };
}

test('execution waits for review, runs in worktree, preserves argv and records evidence', async t => {
  const f = await setup(t);
  let reviewed = false;
  f.options.review = async (state, request, logDir) => {
    assert.equal(fs.existsSync(f.marker), false);
    assert.match(state.snapshot.plan, /Update app and library/);
    assert.equal(request.source.text, source);
    assert.equal(request.argv.at(-1), 'literal $(whoami); echo nope');
    assert.equal(fs.existsSync(path.join(logDir, 'request.json')), true);
    reviewed = true;
    return verdict(request);
  };
  const result = await runDevCommand({ ...input, args: ['literal $(whoami); echo nope'] }, f.options);
  assert.equal(result.passed, true, result.reason);
  assert(reviewed);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'yes');
  assert.match(result.stdout, /diagnostic passed/);
  assert.equal(fs.existsSync(path.join(result.trace, 'review.json')), true);
  assert.equal(fs.existsSync(path.join(f.base, 'sources/app/executed.txt')), false);
  const events = fs.readFileSync(path.join(f.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => e.type.startsWith('dev_run_')).map(e => e.type), ['dev_run_requested', 'dev_run_reviewed', 'dev_run_started', 'dev_run_finished']);
});

test('unrelated and uncertain commands are denied without launching the script', async t => {
  const f = await setup(t);
  for (const extra of [
    { verdict: 'deny', task_relevant: false, reason: 'Unrelated to the plan' },
    { verdict: 'deny', risk: 'unknown', reason: 'Cannot inspect dependency' },
    { verdict: 'allow', risk: 'medium' },
  ]) {
    const result = await runDevCommand(input, { ...f.options, review: async (_s, request) => verdict(request, extra) });
    assert.equal(result.status, 'blocked');
    assert.equal(fs.existsSync(f.marker), false);
  }
});

test('reviewer errors, wrong request ids and changed source fail closed', async t => {
  const f = await setup(t);
  const reviews = [
    async () => { throw new Error('Provider unavailable'); },
    async (_s, request) => verdict(request, { request_id: 'another-request' }),
    async (_s, request) => { fs.appendFileSync(f.script, '\n// changed'); return verdict(request); },
  ];
  for (const review of reviews) {
    const result = await runDevCommand(input, { ...f.options, review });
    assert.equal(result.status, 'blocked');
    assert.equal(fs.existsSync(f.marker), false);
  }
});

test('unknown commands, traversal, symlinks and option targets fail before review', async t => {
  const f = await setup(t);
  fs.symlinkSync(f.commandCenter, path.join(f.feature, 'app/outside'));
  fs.writeFileSync(path.join(f.commandCenter, 'secret.mjs'), source);
  let calls = 0;
  const review = async () => { calls++; throw new Error('Must not review'); };
  for (const patch of [
    { command: 'bash' }, { repo: 'other' }, { target: '../../outside.mjs' },
    { target: 'outside/secret.mjs' }, { target: '-e' }, { target: f.script },
    { target: '.git' }, { timeout_seconds: 99999 }, { args: [null] }, { env: { EXTRA: 'bad' } },
  ]) {
    const result = await runDevCommand({ ...input, ...patch }, { ...f.options, review });
    assert.equal(result.status, 'blocked');
  }
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(f.marker), false);
});

test('active approval, immutable snapshot and enabled profile are required', async t => {
  const f = await setup(t);
  const file = path.join(f.stateDir, 'state.json');
  const original = JSON.parse(fs.readFileSync(file));
  for (const mutate of [
    s => { s.status = 'ready_for_user'; }, s => { s.approved.digest = 'wrong'; },
    s => { s.snapshot.plan += ' changed'; }, s => { s.round = 2; },
  ]) {
    const changed = structuredClone(original); mutate(changed); writeJSON(file, changed);
    assert.equal((await runDevCommand(input, f.options)).status, 'blocked');
  }
  assert.equal(fs.existsSync(f.marker), false);
});

test('call budget includes refused requests and concurrent calls are refused', async t => {
  const f = await setup(t, { maxCallsPerRound: 1 });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const first = runDevCommand(input, { ...f.options, review: async (_s, request) => { await waiting; return verdict(request, { verdict: 'deny' }); } });
  assert.match((await runDevCommand(input, f.options)).reason, /Another dev_run/);
  release(); await first;
  assert.match((await runDevCommand(input, f.options)).reason, /call limit/);
});

test('timeout and output budget stop diagnostic processes and bound disk logs', async t => {
  const f = await setup(t, { timeoutSeconds: 1, maxOutputBytes: 2048 }, 'setInterval(() => {}, 1000);');
  const timeout = await runDevCommand(input, f.options);
  assert.equal(timeout.timed_out, true);
  assert.equal(timeout.passed, false);
  fs.writeFileSync(f.script, "setInterval(() => console.log('x'.repeat(4096)), 1);");
  const noisy = await runDevCommand(input, f.options);
  assert.equal(noisy.output_limited, true);
  assert.equal(noisy.passed, false);
  assert(fs.statSync(path.join(noisy.trace, 'process.log')).size <= 2048);
});

test('cancelled review never launches the process', async t => {
  const f = await setup(t);
  const controller = new AbortController();
  const result = await runDevCommand(input, { ...f.options, signal: controller.signal, review: async (_s, request) => { controller.abort(); return verdict(request); } });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /cancelled/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('focused test paths and named build targets use their configured commands', async t => {
  const f = await setup(t, {}, source, (profile, fixture) => {
    const helper = path.join(fixture.feature, 'app/build.mjs');
    fs.writeFileSync(helper, 'console.log("built target", process.argv.at(-1));');
    Object.assign(profile.repositories.app.devCommands, {
      // A nested Node runner must not inherit the parent runner's internal IPC mode.
      test: { kind: 'test', description: 'Focused Node test', argv: ['env', '-u', 'NODE_TEST_CONTEXT', process.execPath, '--test'] },
      build: { kind: 'build', description: 'Build one fixture target', argv: [process.execPath, helper] },
    });
  });
  const focused = await runDevCommand({ ...input, command: 'test' }, f.options);
  assert.equal(focused.passed, true, focused.reason);
  assert.match(focused.stdout, /diagnostic passed/);
  const build = await runDevCommand({ ...input, command: 'build', target: 'app_tests' }, f.options);
  assert.equal(build.passed, true, build.reason);
  assert.match(build.stdout, /built target app_tests/);
});

test('disabled profiles refuse execution; new approved snapshots have a fresh request budget', async t => {
  const disabled = await setup(t, { enabled: false });
  assert.match((await runDevCommand(input, disabled.options)).reason, /disabled/);
  assert.equal(fs.existsSync(disabled.marker), false);
  const f = await setup(t, { maxCallsPerRound: 1 });
  assert.equal((await runDevCommand(input, f.options)).passed, true);
  assert.match((await runDevCommand(input, f.options)).reason, /call limit/);
  fs.appendFileSync(path.join(path.dirname(f.task), 'plan.md'), '\nAlso check a second local diagnostic.');
  const prepared = await prepare(f.profile, f.task, { replace: true });
  const state = await approve(f.profile, f.id, prepared.digest);
  state.status = 'building'; state.round = 1;
  writeJSON(path.join(f.stateDir, 'state.json'), state);
  assert.equal((await runDevCommand(input, f.options)).passed, true);
});

test('execution reviewer permissions and typed verdict parsing prevent fallback approval', () => {
  const permission = rolePermission('execution-reviewer', ['/tmp/task']);
  assert.equal(permission['*'], 'deny');
  for (const tool of ['bash', 'dev_run', 'edit', 'task', 'webfetch']) assert.notEqual(permission[tool], 'allow');
  assert.equal(permission.execution_submit, 'allow');
  assert.equal(rolePermission('builder').dev_run, 'allow');
  const valid = verdict({ request_id: '123' });
  assert.deepEqual(parseExecutionReview(JSON.stringify(valid), '123'), valid);
  assert.throws(() => parseExecutionReview({ ...valid, risk: 'unknown' }, '123'));
  const encode = events => events.map(JSON.stringify).join('\n');
  const final = { type: 'text', part: { text: 'Submitted' } };
  const submit = { type: 'tool_use', part: { tool: 'execution_submit', state: { status: 'completed', output: JSON.stringify(valid) } } };
  assert.equal(parseToolSubmission(encode([submit, final]), 'execution_submit'), JSON.stringify(valid));
  for (const events of [[final], [submit, submit, final], [submit, final, { type: 'error', error: 'failed' }]]) assert.throws(() => parseToolSubmission(encode(events), 'execution_submit'));
  assert.equal(devRunSettings().enabled, false);
  assert.throws(() => devRunSettings({ enabled: true, maxCallsPerRound: 0 }));
  assert.throws(() => resolveDevCommands({ node: { kind: 'script', description: 'test', argv: ['node'] } }, x => x));
});
