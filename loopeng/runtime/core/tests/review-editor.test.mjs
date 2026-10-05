import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { editorArgv, openReviewEditor, reviewPatch } from '../tui/review-editor.mjs';
import { readerNavigation } from '../tui/navigation.mjs';
import { reviewGuidance } from '../tui/review-guidance.mjs';

function navigation(reserved = []) {
  let listener, consumed = 0, cleared = 0;
  const calls = [], mode = 'command-center.review';
  const api = { mode: { current: () => mode }, route: { current: { name: mode } }, ui: { dialog: { open: false } },
    keymap: { clearPendingSequence: () => cleared++, intercept(name, fn) { assert.equal(name, 'key'); listener = fn; return () => { listener = undefined; }; } } };
  const dispose = readerNavigation(api, mode, { move: x => calls.push(['move', x]), page: (...x) => calls.push(['page', ...x]), edge: x => calls.push(['edge', x]), reserved });
  return { api, calls, dispose, get consumed() { return consumed; }, get cleared() { return cleared; },
    key(name, modifiers = {}) { listener?.({ event: { name, ...modifiers }, consume: () => consumed++ }); } };
}

test('reader navigation handles Ctrl chords before global sequences; unrelated commands remain available', () => {
  const n = navigation();
  for (const key of ['d', 'u', 'f', 'b']) n.key(key, { ctrl: true });
  assert.deepEqual(n.calls, [['page', 1, 0.5], ['page', -1, 0.5], ['page', 1, 1], ['page', -1, 1]]);
  n.key('f'); n.key('a'); n.key('r', { ctrl: true }); n.key('d', { meta: true });
  assert.equal(n.consumed, 4); assert.equal(n.cleared, 4);
});

test('gg is local to the reader; interrupted sequences do not swallow the next shortcut', () => {
  const n = navigation();
  n.key('g'); n.key('g'); assert.deepEqual(n.calls, [['edge', false]]);
  n.key('g'); n.key('j'); n.key('g'); assert.deepEqual(n.calls.at(-1), ['move', 1]);
  n.key('g'); n.key('g', { shift: true }); n.key('G');
  assert.deepEqual(n.calls.slice(-3), [['edge', false], ['edge', true], ['edge', true]]);
  n.dispose(); n.key('d', { ctrl: true }); assert.equal(n.calls.length, 5);
});

test('reader motions leave forms, other routes/modes and explicit action-card shortcuts alone', () => {
  const n = navigation(['ctrl+d']);
  n.key('d', { ctrl: true }); assert.equal(n.consumed, 0);
  n.key('g'); n.api.ui.dialog.open = true; n.key('g'); n.key('u', { ctrl: true });
  n.api.ui.dialog.open = false; n.key('g'); assert.equal(n.calls.length, 0);
  n.api.route.current.name = 'session'; n.key('j');
  n.api.route.current.name = 'command-center.review'; n.api.mode.current = () => 'dialog'; n.key('k');
  assert.equal(n.calls.length, 0);
});

test('editor argv preserves literal arguments, defaults to terminal Vim and waits for Code', () => {
  const argv = editorArgv(['vim', '--cmd', "echo '$(touch SENTINEL)'"], '/tmp/a b/review.diff');
  assert.equal(argv[2], "echo '$(touch SENTINEL)'");
  assert.equal(argv.at(-1), '/tmp/a b/review.diff'); assert(argv.includes('-R'));
  assert.deepEqual(editorArgv(['code'], '/tmp/review.diff'), ['code', '--wait', '/tmp/review.diff']);
  assert.deepEqual(editorArgv(['/Applications/My Editor/editor', 'a b'], '/tmp/review.diff'), ['/Applications/My Editor/editor', 'a b', '/tmp/review.diff']);
  assert.equal(editorArgv(undefined, '/tmp/review.diff', { PATH: '', VISUAL: 'code', EDITOR: 'code' })[0], 'vim');
  assert.throws(() => editorArgv('vim', '/tmp/review.diff'), /массивом/);
});

const review = { id: 'fixture', digest: '123', warnings: ['Неполный просмотр'], repositories: [{ id: 'app', base: 'abc' }],
  files: [{ repo: 'app', path: '../../untrusted.py', label: 'Добавлен', patch: '+first\n' },
    { repo: 'app', path: 'second.py', label: 'Изменён', patch: '+second\n' },
    { repo: 'app', path: 'binary', label: 'Добавлен', message: 'Двоичный файл', binary: true }] };

test('reader and editor explain the next step for ready, accepted and unavailable results', () => {
  const ready = { ...review, status: 'ready_for_user', canAccept: true, canFeedback: true };
  assert.match(reviewGuidance(ready).next, /a · Принять/);
  assert.match(reviewPatch(ready), /:q → OpenCode, затем a/);
  assert(editorArgv(['nvim'], '/tmp/review.diff', {}, ready).some(arg => arg.includes('a: принять задачу')));
  const accepted = { ...ready, status: 'accepted', canAccept: false, canFeedback: false };
  assert.match(reviewGuidance(accepted).next, /уже принят/);
  assert(!reviewPatch(accepted).includes('затем a'));
  assert(editorArgv(['nvim'], '/tmp/review.diff', {}, accepted).some(arg => arg.includes('Результат уже принят')));
  const stale = { ...ready, canAccept: false, acceptReason: 'Файлы изменились после ревью.' };
  assert.match(reviewGuidance(stale).next, /Файлы изменились.*f ·/);
  assert.match(reviewPatch(stale), /Файлы изменились/);
});

test('external editor receives only an isolated snapshot and it is removed on success or failure', async () => {
  for (const fail of [false, true]) {
    let exported, root;
    const open = openReviewEditor({}, review, { file: fail ? undefined : review.files[0], editor: ['editor'], run: async (_, argv, cwd) => {
      root = cwd; exported = argv.at(-1);
      const content = fs.readFileSync(exported, 'utf8');
      assert.match(content, /База: abc/); assert.match(content, /Неполный просмотр/); assert.match(content, /\+first/);
      assert.equal(content.includes('+second'), fail); assert.equal(content.includes('Двоичный файл'), fail);
      assert.equal(fs.statSync(exported).mode & 0o777, 0o400); assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
      assert.equal(exported, `${cwd}/review.diff`);
      if (fail) throw new Error('editor unavailable');
    } });
    if (fail) await assert.rejects(open, /editor unavailable/); else await open;
    assert(!fs.existsSync(exported)); assert(!fs.existsSync(root));
  }
  await assert.rejects(openReviewEditor({}, review, { file: { repo: 'app', path: 'absent' } }), /отсутствует/);
});
