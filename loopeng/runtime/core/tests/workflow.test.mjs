import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, feedback, accept, status, fingerprint, parseAgentOutput, parseReview, parseReviewerOutput, resolveHook } from '../lib/controller.mjs';
import { guardWrite, writablePath } from '../lib/policy.mjs';
import { execute, git } from '../lib/process.mjs';

async function setup(t, options) {
  const f = await fixture(options);
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  return f;
}
async function approved(f) {
  const state = await prepare(f.profile, f.task);
  await approve(f.profile, f.id, state.digest);
  return state;
}
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(x => JSON.parse(x));

test('native CLI parsing separates tool-call commentary from the completed final message', () => {
  const events = [
    { type: 'text', part: { messageID: 'first', text: 'Reading files.' } },
    { type: 'step_finish', part: { messageID: 'first', reason: 'tool-calls' } },
    { type: 'text', part: { messageID: 'final', text: '{"verdict":"approved",' } },
    { type: 'text', part: { messageID: 'final', text: '"summary":"Checked","findings":[]}' } },
    { type: 'step_finish', sessionID: 'native-session', part: { messageID: 'final', reason: 'stop' } },
  ];
  const parsed = parseAgentOutput(events.map(JSON.stringify).join('\n'));
  assert.equal(parsed.session, 'native-session');
  assert.equal(parseReview(parsed.text, ['app']).verdict, 'approved');
});

test('native CLI parsing rejects incomplete steps and errors after an earlier verdict', () => {
  const response = { type: 'text', part: { messageID: 'old', text: '{"verdict":"approved","summary":"Old","findings":[]}' } };
  for (const reason of ['tool-calls', 'length', 'error']) {
    const events = [response, { type: 'step_finish', part: { messageID: 'new', reason } }];
    assert.throws(() => parseAgentOutput(events.map(JSON.stringify).join('\n')), /completed final/);
  }
  assert.throws(() => parseAgentOutput(JSON.stringify(response)), /completed final/);
  assert.throws(() => parseAgentOutput([response, { type: 'step_finish', part: { messageID: 'new', reason: 'stop' } }].map(JSON.stringify).join('\n')), /completed text/);
  assert.throws(() => parseAgentOutput([response, { type: 'error', error: { message: 'Provider failed' } }].map(JSON.stringify).join('\n')), /OpenCode error/);
});

test('plan approval binds the digest; checks/review repair loop stops for the user', async t => {
  const f = await setup(t);
  const planned = await prepare(f.profile, f.task);
  await assert.rejects(run(f.profile, f.id), /Approve/);
  await assert.rejects(approve(f.profile, f.id, 'wrong'), /digest/);
  await approve(f.profile, f.id, planned.digest);
  const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  assert.equal(ready.round, 3);
  const reviewPrompt = fs.readFileSync(path.join(f.stateDir, '3-reviewer-prompt.txt'), 'utf8');
  assert.match(reviewPrompt, /CURRENT CHECK RESULTS, ROUND 3/);
  assert.match(reviewPrompt, /"passed":true/);
  assert.match(reviewPrompt, /Earlier lint failures in feedback are historical/);
  assert.deepEqual(ready.feedback.map(x => x.source), ['checks', 'reviewer']);
  const agents = lines(path.join(f.stateDir, 'mock-agents.jsonl'));
  assert.deepEqual(agents.map(x => [x.role, x.round, x.resumed]), [
    ['builder', 1, false], ['builder', 2, true], ['reviewer', 2, false], ['builder', 3, true], ['reviewer', 3, false],
  ]);
  assert(agents.every(x => x.cwd === f.feature));
  const events = lines(path.join(f.stateDir, 'events.jsonl'));
  for (const review of events.filter(x => x.type === 'reviewer_started')) {
    const end = events.indexOf(review);
    const start = events.findIndex(x => x.type === 'builder_started' && x.round === review.round);
    const checks = events.slice(start, end).filter(x => x.type === 'check');
    assert.deepEqual(checks.map(x => x.phase), ['format', 'format', 'formatCheck', 'formatCheck', 'lint', 'lint', 'test', 'test']);
    assert(checks.every(x => x.passed));
  }
  for (const repo of ready.snapshot.repos) {
    assert.equal(fs.readFileSync(path.join(repo.source, 'value.txt'), 'utf8'), 'original\n');
    assert.equal((await git(repo.root, 'rev-parse', 'HEAD')).trim(), repo.base);
  }
  assert.equal((await run(f.profile, f.id)).round, 3); // Idempotent local status.
  await feedback(f.profile, f.id, 'Improve the final wording without expanding scope.');
  assert.equal((await run(f.profile, f.id)).round, 4);
  assert.equal((await accept(f.profile, f.id)).status, 'accepted');
});

test('post-review edits and untracked files invalidate acceptance', async t => {
  const f = await setup(t, { scenario: 'pass' });
  await approved(f);
  const ready = await run(f.profile, f.id);
  fs.writeFileSync(path.join(f.feature, 'app', 'surprise.txt'), 'new source');
  assert.notEqual(await fingerprint(ready.snapshot), ready.reviewedFingerprint);
  await assert.rejects(accept(f.profile, f.id), /Files changed/);
});

test('path guard rejects sibling features, traversal, symlinks and patch moves', async t => {
  const f = await setup(t, { scenario: 'pass' });
  fs.symlinkSync(f.commandCenter, path.join(f.feature, 'outside'));
  fs.symlinkSync(path.join(f.commandCenter, 'missing.txt'), path.join(f.feature, 'dangling'));
  assert.throws(() => writablePath(f.feature, 'dangling'), /ENOENT/);
  assert.throws(() => writablePath(f.feature, '../other/new.txt'), /outside/);
  assert.throws(() => writablePath(f.feature, 'outside/new.txt'), /outside/);
  assert.throws(() => writablePath(f.feature, 'app/.git'), /outside|\.git/);
  assert.throws(() => guardWrite('apply_patch', { patchText: '*** Begin Patch\n*** Update File: app/value.txt\n*** Move to: ../other/value.txt\n*** End Patch' }, f.feature), /outside/);
  assert.equal(writablePath(f.feature, 'app/new-folder/file.txt'), path.join(f.feature, 'app/new-folder/file.txt'));
});

test('missing mandatory checks and changed plans cannot silently proceed', async t => {
  const f = await setup(t);
  await approved(f);
  fs.appendFileSync(path.join(path.dirname(f.task), 'plan.md'), '\nNew scope.\n');
  await assert.rejects(prepare(f.profile, f.task), /--replace/);
  const replacement = await prepare(f.profile, f.task, { replace: true });
  assert.equal(replacement.status, 'prepared');
  await assert.rejects(run(f.profile, f.id), /Approve/);
  const p = JSON.parse(fs.readFileSync(f.profile));
  p.repositories.app.checks.lint = [];
  writeJSON(f.profile, p);
  await assert.rejects(prepare(f.profile, f.task, { replace: true }), /lint/);
});

for (const [scenario, maxRounds, expected] of [
  ['always-fail', 2, /Reached 2 rounds/],
  ['invalid-review', 5, /JSON/],
  ['reviewer-write', 5, /changed during review/],
]) test(`fail closed: ${scenario}`, async t => {
  const f = await setup(t, { scenario, maxRounds });
  await approved(f);
  const result = await run(f.profile, f.id);
  assert.equal(result.status, 'blocked');
  assert.match(result.error, expected);
  await assert.rejects(accept(f.profile, f.id), /ready_for_user/);
});

test('strict reviewer verdict rejects contradictions and extra fields', () => {
  const finding = { severity: 'blocking', repository: 'app', path: 'a', reason: 'bug', fix: 'repair' };
  assert.throws(() => parseReview(JSON.stringify({ verdict: 'approved', summary: 'ok', findings: [finding] }), ['app']), /despite blocking/);
  assert.throws(() => parseReview(JSON.stringify({ verdict: 'approved', summary: 'ok', findings: [], extra: true }), ['app']), /object/);
  assert.throws(() => parseReview('null', ['app']), /object/);
});

test('review JSON rejects prose, ambiguous objects and missing or extra fields', () => {
  const verdict = JSON.stringify({ verdict: 'approved', summary: 'Checked', findings: [] });
  assert.throws(() => parseReview(`All verification is complete.\n\n${verdict}`, ['app']));
  for (const invalid of [
    `${verdict}\n${verdict}`,
    `Preface\n${verdict}\n${verdict}`,
    `Preface\n${verdict}\nActually, changes are required.`,
    `[${verdict}]`,
    `Preface\n{"verdict":"approved","summary":"missing findings"}`,
    `Preface\n{"verdict":"approved","summary":"extra field","findings":[],"extra":true}`,
  ]) assert.throws(() => parseReview(invalid, ['app']));
});

test('review submission requires exactly one successful typed tool result, independent of prose', () => {
  const review = JSON.stringify({ verdict: 'approved', summary: 'Checked', findings: [] });
  const submit = { type: 'tool_use', part: { tool: 'review_submit', state: { status: 'completed', output: review } } };
  const final = { type: 'text', part: { text: 'The review has been submitted.' } };
  const encode = events => events.map(JSON.stringify).join('\n');
  assert.equal(parseReviewerOutput(encode([submit, final])), review);
  assert.throws(() => parseReviewerOutput(encode([final])), /Exactly one/);
  assert.throws(() => parseReviewerOutput(encode([submit, submit, final])), /Exactly one/);
  assert.throws(() => parseReviewerOutput(encode([{ type: 'tool_use', part: { tool: 'review_submit', state: { status: 'error', output: review } } }, final])), /Exactly one/);
  assert.throws(() => parseReviewerOutput(encode([submit, final, { type: 'error', error: 'provider failed' }])), /OpenCode error/);
});

test('publication can commit unchanged contents; feedback updates the same MR; Jira follows human acceptance', async t => {
  const f = await setup(t, { scenario: 'pass', publication: true });
  await approved(f);
  const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  const log = path.join(f.stateDir, 'mock-hooks.jsonl');
  assert.deepEqual(lines(log).map(x => x.name), ['mergeRequest']);
  assert.notEqual(ready.publishedHeads.app, ready.snapshot.repos[0].base);
  await feedback(f.profile, f.id, 'Refine the implementation.');
  const revised = await run(f.profile, f.id);
  assert.equal(revised.status, 'ready_for_user', revised.error);
  const calls = lines(log);
  assert.deepEqual(calls.map(x => x.name), ['mergeRequest', 'mergeRequest']);
  assert.equal(calls[1].previous.id, calls[0].name + '-demo');
  assert.notEqual(calls[0].key, calls[1].key);
  assert.equal((await accept(f.profile, f.id)).status, 'accepted');
  assert.deepEqual(lines(log).map(x => x.name), ['mergeRequest', 'mergeRequest', 'jiraUpdate']);
});

test('uncertain publication needs user resolution and resumes without another Builder', async t => {
  const f = await setup(t, { scenario: 'pass', publication: true });
  const p = JSON.parse(fs.readFileSync(f.profile));
  p.hooks.mergeRequest = [process.execPath, '-e', 'process.exit(1)'];
  writeJSON(f.profile, p);
  await approved(f);
  const failed = await run(f.profile, f.id);
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.hookResults.mergeRequest.status, 'started');
  await assert.rejects(feedback(f.profile, f.id, 'retry'), /uncertain/);
  await assert.rejects(run(f.profile, f.id), /uncertain/);
  await resolveHook(f.profile, f.id, 'mergeRequest', { applied: true, id: 'mr-1', url: 'https://example.invalid/1' });
  const ready = await run(f.profile, f.id);
  assert.equal(ready.status, 'ready_for_user', ready.error);
  assert.equal(ready.round, 1);
  assert.equal(lines(path.join(f.stateDir, 'mock-agents.jsonl')).filter(x => x.role === 'builder').length, 1);
});

test('concurrent execution is refused', async t => {
  const f = await setup(t);
  await approved(f);
  fs.mkdirSync(path.join(f.stateDir, '.lock'));
  writeJSON(path.join(f.stateDir, '.lock/owner.json'), { pid: process.pid });
  await assert.rejects(run(f.profile, f.id), /busy/);
});

test('subprocess timeout terminates a hanging command', async () => {
  const result = await execute([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeout: 0.15 });
  assert(result.timedOut);
  assert.notEqual(result.code, 0);
});

test('check-only validation cannot mutate reviewed source', async t => {
  const f = await setup(t, { scenario: 'pass' });
  const p = JSON.parse(fs.readFileSync(f.profile));
  p.repositories.app.checks.test = [[process.execPath, '-e', 'require("node:fs").appendFileSync("value.txt", "unexpected mutation\\n")']];
  writeJSON(f.profile, p);
  await approved(f);
  const result = await run(f.profile, f.id);
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /Validation changed source/);
  assert.equal(lines(path.join(f.stateDir, 'mock-agents.jsonl')).filter(x => x.role === 'reviewer').length, 0);
});

test('branch changes after review prevent acceptance even with identical contents', async t => {
  const f = await setup(t, { scenario: 'pass' });
  await approved(f);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
  await git(path.join(f.feature, 'app'), 'switch', '-c', 'another-feature');
  await assert.rejects(accept(f.profile, f.id), /branch changed/);
});

test('worker model effort is forwarded separately for Builder and Reviewer', async t => {
  const f = await setup(t, { scenario: 'pass' });
  const profile = JSON.parse(fs.readFileSync(f.profile));
  profile.reasoningEffort = { builder: 'low', reviewer: 'high' };
  writeJSON(f.profile, profile);
  await approved(f);
  const state = await run(f.profile, f.id);
  assert.equal(state.status, 'ready_for_user', state.error);
  const workers = lines(path.join(f.stateDir, 'mock-agents.jsonl'));
  assert.deepEqual(workers.map(worker => [worker.role, worker.configuredEffort]), [['builder', 'low'], ['reviewer', 'high']]);
});
