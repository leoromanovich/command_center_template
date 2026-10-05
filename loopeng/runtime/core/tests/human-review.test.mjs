import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, status, fingerprint, feedback, accept } from '../lib/controller.mjs';
import { git } from '../lib/process.mjs';
import { loadHumanReview } from '../lib/human-review.mjs';

async function ready(t) {
  const f = await fixture({ scenario: 'pass' }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const prepared = await prepare(f.profile, f.task); await approve(f.profile, f.id, prepared.digest); await run(f.profile, f.id);
  return f;
}
async function recordFixtureReview(f) {
  const state = status(f.profile, f.id); state.reviewedFingerprint = await fingerprint(state.snapshot);
  writeJSON(path.join(f.stateDir, 'state.json'), state);
}

test('human review shows all repos and new file content without writing the worktree or staging files', async t => {
  const f = await ready(t), library = path.join(f.feature, 'library');
  const before = await git(library, 'status', '--porcelain=v1', '-z');
  const data = await loadHumanReview(f.profile, f.id);
  assert.equal(data.canAccept, true); assert.equal(data.files.length, 3);
  assert.equal(data.acceptReason, undefined);
  assert.match(data.files.find(file => file.repo === 'app').patch, /-original\n\+valid app 1/);
  const added = data.files.find(file => file.path === 'new.txt'); assert.match(added.patch, /\+New file in round 1/);
  assert.equal(added.additions, 1); assert.equal(added.deletions, 0);
  assert.equal(await git(library, 'status', '--porcelain=v1', '-z'), before);
  assert.equal(data.checks.every(check => check.passed), true);
  assert.equal(status(f.profile, f.id).status, 'ready_for_user');
});

test('committed feature changes remain visible relative to the approved base', async t => {
  const f = await ready(t);
  for (const repo of ['app', 'library']) { const root = path.join(f.feature, repo); await git(root, 'add', '-A'); await git(root, 'commit', '-m', 'Fixture publication'); }
  const data = await loadHumanReview(f.profile, f.id);
  assert.equal(data.files.length, 3); assert.match(data.files.find(file => file.path === 'new.txt').patch, /New file in round 1/);
  assert.match(data.files.find(file => file.repo === 'app').patch, /-original/);
});

test('literal paths, deleted files, empty files and missing final newline are represented accurately', async t => {
  const f = await ready(t), root = path.join(f.feature, 'app');
  fs.unlinkSync(path.join(root, 'value.txt'));
  fs.writeFileSync(path.join(root, 'literal[1].txt'), 'literal content\n');
  fs.writeFileSync(path.join(root, 'literal1.txt'), 'different content\n');
  await git(root, '--literal-pathspecs', 'add', '--', 'literal[1].txt', 'literal1.txt');
  fs.writeFileSync(path.join(root, 'empty.txt'), ''); fs.writeFileSync(path.join(root, 'new file 日本語.txt'), 'no newline');
  await recordFixtureReview(f);
  const data = await loadHumanReview(f.profile, f.id), literal = data.files.find(file => file.path === 'literal[1].txt');
  assert.match(literal.patch, /literal content/); assert(!literal.patch.includes('different content'));
  assert.equal(data.files.find(file => file.repo === 'app' && file.path === 'value.txt').status, 'D');
  assert.match(data.files.find(file => file.path === 'empty.txt').message, /пустой/);
  assert.match(data.files.find(file => file.path === 'new file 日本語.txt').patch, /No newline at end of file/);
  assert.equal(data.canAccept, true);
});

test('binary and symlink previews do not decode binary data or read link targets', async t => {
  const f = await ready(t), root = path.join(f.feature, 'app');
  const outside = path.join(f.base, 'outside.txt'); fs.writeFileSync(outside, 'CONTENTS_MUST_NOT_BE_READ');
  fs.symlinkSync(outside, path.join(root, 'link.txt')); fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 255, 13, 10]));
  await recordFixtureReview(f);
  const data = await loadHumanReview(f.profile, f.id);
  assert.match(data.files.find(file => file.path === 'link.txt').patch, /120000/);
  assert(!JSON.stringify(data).includes('CONTENTS_MUST_NOT_BE_READ'));
  assert.equal(data.files.find(file => file.path === 'image.bin').binary, true);
});

test('oversized or incomplete previews disable acceptance without presenting a partial patch as complete', async t => {
  const f = await ready(t);
  const limited = await loadHumanReview(f.profile, f.id, { fileBytes: 40 });
  assert.equal(limited.complete, false); assert.equal(limited.canAccept, false);
  assert.match(limited.acceptReason, /не полностью/);
  assert(limited.files.every(file => !file.patch)); assert.match(limited.warnings.join(' '), /недоступна/);
  const shortList = await loadHumanReview(f.profile, f.id, { maxFiles: 1 });
  assert.equal(shortList.files.length, 1); assert.equal(shortList.canAccept, false);
});

test('post-review edits are visible but cannot be accepted; feedback remains available', async t => {
  const f = await ready(t); fs.appendFileSync(path.join(f.feature, 'app/value.txt'), 'post-review edit\n');
  const data = await loadHumanReview(f.profile, f.id);
  assert.equal(data.canAccept, false); assert.equal(data.canFeedback, true); assert.match(data.warnings.join(' '), /изменились/);
  assert.match(data.acceptReason, /изменились/);
  assert(data.files.some(file => file.patch?.includes('post-review edit')));
});

test('accepted result remains readable and explains why it cannot be accepted again', async t => {
  const f = await ready(t); const accepted = await accept(f.profile, f.id);
  assert.equal(accepted.status, 'accepted');
  const data = await loadHumanReview(f.profile, f.id);
  assert.equal(data.canAccept, false); assert.equal(data.canFeedback, false);
  assert.equal(data.acceptedAt, accepted.acceptedAt); assert(data.files.length > 0);
  assert.match(data.acceptReason, /уже принят/);
  assert.deepEqual(status(f.profile, f.id), accepted, 'Opening an accepted result must not reset it');
});

test('feedback binds the review the user actually opened', async t => {
  const f = await ready(t), data = await loadHumanReview(f.profile, f.id);
  await assert.rejects(feedback(f.profile, f.id, 'old comment', { expectedDigest: 'obsolete', expectedFingerprint: data.fingerprint }), /Plan changed/);
  await assert.rejects(feedback(f.profile, f.id, 'old comment', { expectedDigest: data.digest, expectedFingerprint: 'obsolete' }), /Reviewed result changed/);
  assert.equal(status(f.profile, f.id).status, 'ready_for_user');
});
