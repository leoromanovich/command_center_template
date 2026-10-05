import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../../core/demo/fixture.mjs';
import { prepare, loadProfile, status, approve, run } from '../../core/lib/controller.mjs';
import { openTasks, shortcutHint, streamText } from '../lib/view.mjs';
import { setupDemo } from '../setup-demo.mjs';
import { git } from '../../core/lib/process.mjs';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { loadPi } from '../lib/pi.mjs';
import { install } from '../install.mjs';
import { agentCommand } from '../../core/lib/agent-runtime.mjs';
import extension from '../extension.mjs';
import { identity } from '../../core/lib/recovery.mjs';
import { eventWriter } from '../lib/events.mjs';
import { chatBlocks, createLiveRenderer, splitLines } from '../lib/live-view.mjs';
import { overlayPointer } from '../lib/pointer.mjs';

test('task view exposes Docker command state and live Builder output in the same reader', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const s = await prepare(f.profile, f.task);
  s.snapshot.sandbox = { kind: 'docker' };
  fs.writeFileSync(path.join(f.stateDir, 'state.json'), JSON.stringify(s));
  fs.mkdirSync(path.join(f.stateDir, 'docker-activity'));
  fs.writeFileSync(path.join(f.stateDir, 'docker-activity/run.json'), JSON.stringify({ id: 'run', container: 'test-container', role: 'builder', status: 'running', started: new Date().toISOString(), owner: identity(), argv: ['python', 'probe.py'], cwd: '/workspace/app', readonly: false }));
  fs.mkdirSync(path.join(f.stateDir, 'pi-events'));
  fs.writeFileSync(path.join(f.stateDir, 'pi-events/123-test.jsonl'), [
    { type: 'started', role: 'builder', owner: identity(), sessionID: 'test', round: 1 },
    { type: 'docker_output', role: 'builder', text: 'live-probe-output' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const ui = await screen(t, f);
  ui.render();
  await ui.key('\r');
  assert.match(ui.render(), /Docker ● builder: python probe.py/);
  await ui.key('j'); await ui.key('j'); await ui.key('j'); await ui.key('\r');
  assert.match(ui.render(), /test-container/);
  assert.match(ui.render(), /source RW/);
  await ui.key('q'); ui.render();
  await ui.key('j'); await ui.key('j'); await ui.key('\r');
  assert.match(ui.render(), /live-probe-output/);
});

async function screen(t, f, options = {}) {
  const { sdk } = await loadPi(); sdk.initTheme('dark', false);
  let component, finish;
  const theme = { fg: (_name, text) => text };
  const context = { mode: 'tui', ui: { custom(factory) { return new Promise(resolve => {
    finish = () => { component?.dispose(); resolve(); };
    component = factory({ terminal: { rows: 26 }, requestRender() {} }, theme, {}, finish);
  }); } } };
  const promise = openTasks(context, loadProfile(f.profile), options);
  for (let i = 0; i < 100 && !component; i++) await new Promise(r => setTimeout(r, 10));
  assert(component); t.after(async () => { finish(); await promise; });
  return { render: (width = 120) => stripVTControlCharacters(component.render(width).join('\n')),
    mouse: event => component.handleMouse({ button: 'none', x: 90, y: 7, shift: false, alt: false, ctrl: false, ...event }),
    async key(value) { component.handleInput(value); await new Promise(r => setTimeout(r, 25)); } };
}

test('mouse focuses and scrolls the live pane; j/k and Russian keys continue from the pointer focus', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task);
  const before = fs.readFileSync(path.join(f.stateDir, 'state.json'), 'utf8');
  const writer = eventWriter(f.stateDir, { role: 'builder', round: 1, owner: identity() });
  writer.emit({ type: 'text_delta', text: Array.from({ length: 90 }, (_, i) => `row-${i}\n`).join('') + 'END-OF-STREAM' });
  const ui = await screen(t, f); ui.render(); await ui.key('\r'); assert.match(ui.render(), /END-OF-STREAM/);
  ui.mouse({ type: 'press', button: 'left' });
  assert.match(ui.render(), /Tab меню/);
  await ui.key('k'); const scrolled = ui.render();
  assert(!scrolled.includes('END-OF-STREAM')); assert.match(scrolled, /пауза прокрутки/);
  await ui.key('о'); assert.match(ui.render(), /END-OF-STREAM/); // physical j
  await ui.key('л'); assert(!ui.render().includes('END-OF-STREAM')); // physical k
  await ui.key('l'); ui.render();
  ui.mouse({ type: 'wheel', wheelDelta: -6 }); const wheel = ui.render();
  assert(!wheel.includes('END-OF-STREAM'));
  writer.emit({ type: 'text_delta', text: '\nNEW-OUTPUT' }); assert.deepEqual(ui.render().match(/row-\d+/g), wheel.match(/row-\d+/g));
  ui.mouse({ type: 'wheel', wheelDelta: 6 }); assert.match(ui.render(), /END-OF-STREAM/);
  await ui.key('l'); assert.match(ui.render(), /NEW-OUTPUT/);
  ui.mouse({ type: 'press', button: 'left', x: 3, y: 4 }); assert.match(ui.render(), /❯ План/);
  await ui.key('j'); assert.match(ui.render(), /❯ Проверки/); // Left focus is restored.
  ui.mouse({ type: 'wheel', wheelDelta: -6 }); assert(!ui.render().includes('NEW-OUTPUT'));
  assert.match(ui.render(), /Tab меню/); // Wheel over the right pane selects keyboard focus too.
  await ui.key('w'); assert(!ui.render().includes('Обсудить с Orchestrator'));
  ui.mouse({ type: 'wheel', wheelDelta: -6 }); assert(!ui.render().includes('NEW-OUTPUT'));
  await ui.key('g'); await ui.key('g'); assert.match(ui.render(), /row-0/);
  ui.mouse({ type: 'wheel', wheelDelta: 3 }); assert(!ui.render().includes('row-0\n'));
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'state.json'), 'utf8'), before);
});

test('regular terminal SGR input reaches the task panel and reader, without typing or executing clicks', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task);
  const writer = eventWriter(f.stateDir, { role: 'builder', round: 1, owner: identity() });
  writer.emit({ type: 'text_delta', text: Array.from({ length: 90 }, (_, i) => `raw-${i}\n`).join('') + 'RAW-END' });
  const ui = await screen(t, f); ui.render(); await ui.key('\r'); ui.render();
  await ui.key('\x1b[<0;90;9M'); // Primary press, inside right pane.
  await ui.key('k'); assert(!ui.render().includes('RAW-END'));
  await ui.key('l'); ui.render();
  await ui.key('\x1b[<64;90;9M'); assert(!ui.render().includes('RAW-END'));
  await ui.key('\x1b[<65;90;9M'); assert.match(ui.render(), /RAW-END/);
  for (const packet of ['\x1b[<64;90;9m', '\x1b[<66;90;9M', '\x1b[<80;90;9M', '\x1b[<64;999;9M']) {
    await ui.key(packet); assert.match(ui.render(), /RAW-END/);
  }
  await ui.key('w'); ui.render(); await ui.key('\x1b[<64;90;9M'); assert(!ui.render().includes('RAW-END'));
  assert.equal(status(f.profile, f.id).status, 'prepared');
});

test('regular mouse capture is scoped, suspendable, and leaves fullscreen mouse ownership to Pi', () => {
  const writes = [], events = [], bounds = { row: 2, col: 4, width: 100, height: 20 };
  const pointer = overlayPointer({ mode: 'regular', terminal: { write: s => writes.push(s) } }, () => bounds, e => events.push(e));
  pointer.enable(); pointer.enable(); assert.equal(writes.length, 1);
  assert(pointer.input('\x1b[<64;15;8M')); assert.equal(events[0].x, 10); assert.equal(events[0].y, 5); assert.equal(events[0].wheelDelta, -3);
  assert.equal(pointer.input('k'), false);
  pointer.disable(); assert(writes.at(-1).endsWith('\x1b[?1000l'));
  pointer.input('\x1b[<64;15;8M'); assert.equal(events.length, 1);
  pointer.enable(); pointer.disable(); assert.equal(writes.length, 4);
  const fullscreen = overlayPointer({ mode: 'fullscreen', terminal: { write: () => assert.fail('Pi owns mouse tracking') } }, () => bounds, () => assert.fail('Native events must not be dispatched twice'));
  fullscreen.enable(); fullscreen.input('\x1b[<64;15;8M'); fullscreen.disable();
});

test('task split follows live output and new workers; Russian navigation can pause, expand and inspect history', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task);
  const before = fs.readFileSync(path.join(f.stateDir, 'state.json'), 'utf8');
  const builder = eventWriter(f.stateDir, { role: 'builder', round: 1, owner: identity(), sessionID: 'builder-live' });
  builder.emit({ type: 'text_delta', text: '**BUILD-START**\n\n' });
  const ui = await screen(t, f); ui.render(); await ui.key('\r');
  let output = ui.render(); assert.match(output, /Обсудить с Orchestrator.*│/); assert.match(output, /BUILD-START/);
  assert.match(output, /builder · круг 1 · работает/); assert.match(output, /Tab live/);
  builder.emit({ type: 'text_delta', text: 'CHUNK-A\n' });
  builder.emit({ type: 'text_delta', text: 'CHUNK-B\n' });
  assert.match(ui.render(), /CHUNK-A/); assert.match(ui.render(), /CHUNK-B/);
  builder.emit({ type: 'text_delta', text: Array.from({ length: 65 }, (_, i) => `scroll-line-${i}\n`).join('') });
  await ui.key('\t'); await ui.key('п'); await ui.key('п'); assert.match(ui.render(), /BUILD-START/);
  builder.emit({ type: 'text_delta', text: 'END-OF-STREAM\n' });
  assert.match(ui.render(), /BUILD-START/); assert(!ui.render().includes('END-OF-STREAM'));
  await ui.key('д'); assert.match(ui.render(), /END-OF-STREAM/);
  await ui.key('ц'); assert(!ui.render().includes('Обсудить с Orchestrator'));
  assert.match(ui.render(), /END-OF-STREAM/); await ui.key('й');
  builder.emit({ type: 'finished' });
  const reviewer = eventWriter(f.stateDir, { role: 'reviewer', round: 1, owner: identity(), sessionID: 'reviewer-live' });
  reviewer.emit({ type: 'thinking_delta', text: 'CHECKING-SECURITY' });
  output = ui.render(); assert.match(output, /reviewer · круг 1 · работает/); assert.match(output, /CHECKING-SECURITY/);
  assert(!output.includes('END-OF-STREAM'));
  // On a narrow terminal the same view is one key away, with no horizontal clipping.
  output = ui.render(80); assert(!output.includes('│')); assert.match(output, /w весь экран/);
  await ui.key('\t'); assert.match(ui.render(80), /CHECKING-SECURITY/);
  await ui.key('q'); ui.render();
  for (let i = 0; i < 4; i++) { await ui.key('j'); ui.render(); }
  assert.match(ui.render(), /END-OF-STREAM/); // Older Builder row pins the preview.
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'state.json'), 'utf8'), before);
});

test('live tool updates coalesce, final output replaces chunks, and review submission stays single', () => {
  const result = text => ({ content: [{ type: 'text', text }] });
  const args = { verdict: 'approved', findings: [], summary: 'review-summary' };
  const events = [
    { type: 'thinking_delta', text: 'one ' }, { type: 'thinking_delta', text: 'two' },
    { type: 'text_delta', text: 'answer' },
    { type: 'tool', id: 'run', name: 'cc_exec', args: { command: 'python test.py' } },
    { type: 'docker_output', text: 'first' },
    { type: 'tool_update', id: 'run', result: result('first') },
    { type: 'tool_update', id: 'run', result: result(' second') },
  ];
  const before = JSON.stringify(events), blocks = chatBlocks(events);
  assert.equal(blocks.length, 3); assert.equal(blocks[0].text, 'one two'); assert.equal(blocks[2].output, 'first second');
  assert.equal(blocks[2].done, false); assert.equal(JSON.stringify(events), before);
  events.push({ type: 'tool_result', id: 'run', result: result('complete') });
  assert.equal(chatBlocks(events)[2].output, 'complete');
  events.push({ type: 'tool', id: 'review', name: 'review_submit', args }, { type: 'tool_result', id: 'review', result: result(JSON.stringify(args)) });
  assert.equal(chatBlocks(events).at(-1).output, '✓ Заключение принято.');
  events.at(-1).error = true; assert.match(chatBlocks(events).at(-1).output, /review-summary/);
});

test('native live rendering contains control sequences, limits tool output and aligns Unicode columns', async () => {
  const { sdk, tui: widgets } = await loadPi(); sdk.initTheme('dark', false);
  const renderer = createLiveRenderer({ sdk, widgets, theme: { fg: (_color, s) => s }, tui: { requestRender() {} }, cwd: '/tmp' });
  const stream = { file: 'test', events: [
    { type: 'tool', id: '1', name: 'cc_read', args: { path: '\x1b[2Jsource.py' } },
    { type: 'tool_result', id: '1', result: { content: [{ type: 'text', text: '\x1b]52;c;malicious\x07' + Array.from({ length: 30 }, (_, i) => `result-${i}\n`).join('') }] } },
    { type: 'text_delta', text: '\x1b[2J**assistant**' },
  ] };
  const collapsed = renderer.render(stream, 70).join('\n');
  assert(!collapsed.includes('\x1b[2J')); assert(!collapsed.includes('\x1b]52;')); assert.match(collapsed, /полный вывод/);
  assert(!collapsed.includes('result-0\n'));
  assert.match(renderer.render(stream, 70, true).join('\n'), /result-0/);
  const combined = splitLines(['Привет 界'], ['справа'], 15, 20, widgets, ' │ ')[0];
  assert.equal(widgets.visibleWidth(combined.split(' │ ')[0]), 15);
  for (const width of [20, 70, 100]) assert(renderer.render(stream, width).every(line => widgets.visibleWidth(line) <= width));
});

test('shortcut hints distinguish actions by color and preserve readable labels', () => {
  const calls = [];
  const theme = { fg(color, text) { calls.push({ color, text }); return text; } };
  const hint = 'j/k выбор · a принять · m сообщение · u публикация · s остановить · q назад';
  assert.equal(shortcutHint(theme, hint), hint);
  assert.deepEqual(calls.filter(x => x.text.trim() && !x.text.startsWith(' ')), [
    { color: 'mdLink', text: 'j/k' }, { color: 'success', text: 'a' },
    { color: 'customMessageLabel', text: 'm' }, { color: 'mdHeading', text: 'u' },
    { color: 'error', text: 's' }, { color: 'muted', text: 'q' },
  ]);
  assert(calls.some(x => x.color === 'muted' && x.text === ' сообщение'));
  for (const [route, color] of [['tasks', 'mdLink'], ['action', 'success'], ['publication', 'mdHeading'], ['cleanup', 'error']]) {
    calls.length = 0;
    shortcutHint(theme, 'Enter действие', route);
    assert.deepEqual(calls[0], { color, text: 'Enter' });
  }
});

test('CC/task usage is accessible with t and Russian е; direct stats never switch roles or approve a task', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task);
  const sessionDir = path.join(f.stateDir, 'pi-sessions/builder'); fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'test.jsonl'), [
    { type: 'session', id: 'usage-test' },
    { type: 'message', id: 'usage-message', parentId: null, timestamp: '2026-09-24', message: { role: 'assistant', provider: 'zai', model: 'glm-5.3-flash', usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 } } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const ui = await screen(t, f); assert.match(ui.render(), /t статистика CC/);
  await ui.key('е'); assert.match(ui.render(), /Весь Command Center/); assert.match(ui.render(), /180 токенов/);
  await ui.key('й'); assert.match(ui.render(), /Command Center · задачи/);
  await ui.key('\r'); assert.match(ui.render(), /t статистика/);
  await ui.key('t'); assert.match(ui.render(), /Задача demo-feature/); assert.match(ui.render(), /180 токенов/);
  await ui.key('q'); assert.match(ui.render(), /Обсудить с Orchestrator/);
  const direct = await screen(t, f, { initial: 'usage-task', selected: f.id, onRole: () => assert.fail('Reading usage must not change role') });
  assert.match(direct.render(), /180 токенов/); await direct.key('q');
  assert.equal(status(f.profile, f.id).status, 'prepared');
});

test('Russian layout navigates tasks and documents; modified keys, releases and pasted text do not activate actions', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  fs.appendFileSync(path.join(path.dirname(f.task), 'plan.md'), '\n' + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.\n`).join('\n'));
  await prepare(f.profile, f.task);
  const ui = await screen(t, f); ui.render(); await ui.key('\r'); ui.render();
  await ui.key('о'); assert.match(ui.render(), /❯ План/);
  await ui.key('о'); assert.match(ui.render(), /❯ Проверки/);
  await ui.key('л'); assert.match(ui.render(), /❯ План/);
  for (const key of ['\x1b[1081;5u', '\x1b[1081;3u', '\x1b[1081;1:3u', '\x1b[200~ф\x1b[201~']) {
    await ui.key(key); assert.match(ui.render(), /❯ План/);
  }
  await ui.key('з'); assert.match(ui.render(), /Demo plan/);
  await ui.key('П'); assert(!ui.render().includes('Demo plan'));
  await ui.key('п'); await ui.key('п'); assert.match(ui.render(), /Demo plan/);
  // Kitty Shift, explicit uppercase, key release and unmodified Unicode keys.
  for (const end of ['\x1b[1087;2u', '\x1b[1055u']) {
    await ui.key(end); assert(!ui.render().includes('Demo plan'));
    await ui.key('\x1b[1087;1:3u'); await ui.key('\x1b[1087;1:3u'); assert(!ui.render().includes('Demo plan'));
    await ui.key('\x1b[1087u'); await ui.key('\x1b[1087u'); assert.match(ui.render(), /Demo plan/);
  }
  await ui.key('й'); assert.match(ui.render(), /❯ План/);
  await ui.key('\x1b[27;1;1081~'); assert.match(ui.render(), /Command Center · задачи/);
  assert.equal(status(f.profile, f.id).status, 'prepared');
});

test('review stream collapses only a matching successful submission echo and preserves raw events', () => {
  const args = { verdict: 'approved', summary: 'unique-review-summary', findings: [] };
  const call = { type: 'tool', id: 'review-1', name: 'review_submit', args };
  const result = { type: 'tool_result', id: call.id, name: call.name, error: false,
    result: { content: [{ type: 'text', text: JSON.stringify({ findings: [], summary: args.summary, verdict: args.verdict }) }] } };
  const stream = { events: [call, result, { type: 'text_delta', text: 'Review finished.' }] };
  const before = JSON.stringify(stream);
  const rendered = streamText(stream);
  assert.equal(rendered.split(args.summary).length - 1, 1);
  assert.match(rendered, /✓ review_submit: заключение принято/);
  assert.match(rendered, /Review finished/);
  assert.equal(JSON.stringify(stream), before);
  for (const altered of [{ ...result, error: true }, { ...result, id: 'other-call' }]) {
    const visible = streamText({ events: [call, altered] });
    assert.equal(visible.split(args.summary).length - 1, 2);
    assert(!visible.includes('заключение принято'));
  }
  // A truncated log may retain the response without the call; keep that verdict visible.
  assert.match(streamText({ events: [result] }), /unique-review-summary/);
  const changed = { ...result, result: { content: [{ type: 'text', text: 'Validation failed: missing path' }] } };
  assert.match(streamText({ events: [call, changed] }), /Validation failed: missing path/);
});

test('knowledge proposals open in one reader; selection and leaving never authorize an update', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const s = await prepare(f.profile, f.task);
  s.snapshot.knowledgeBase = { submodule: 'knowledge' }; s.status = 'accepted';
  fs.writeFileSync(path.join(f.stateDir, 'state.json'), JSON.stringify(s));
  const folder = path.join(f.stateDir, 'knowledge-update'); fs.mkdirSync(folder);
  const proposal = { id: 'api', title: 'Document API', paths: ['docs/api.md'], reason: 'New API', evidence: 'Reviewed tests' };
  const file = path.join(folder, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'proposed', proposals: [proposal] }));
  const before = fs.readFileSync(file, 'utf8'), ui = await screen(t, f);
  assert.match(ui.render(), /база: предложения/);
  await ui.key('\r'); ui.render(); await ui.key('b');
  assert.match(ui.render(), /Document API/); assert.match(ui.render(), /Enter одобрить и запустить/);
  await ui.key('1'); assert.match(ui.render(), /\[ \] Document API/);
  await ui.key('q'); assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, JSON.stringify({ status: 'capture_failed', error: 'Capture failed', proposals: [proposal] }));
  ui.render(); await ui.key('b'); assert.match(ui.render(), /c повторить снимок кода/);
  assert(!ui.render().includes('Enter одобрить'));
});

test('accept opens publication, closing does nothing, edited message is committed only by explicit Enter', { timeout: 60000 }, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publish-ui-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const f = await setupDemo(path.join(parent, 'fixture'), 'no-action');
  const s = await prepare(f.profile, f.task); await approve(f.profile, f.id, s.digest);
  assert.equal((await run(f.profile, f.id)).status, 'ready_for_user');
  const ui = await screen(t, f); ui.render(); await ui.key('\r'); ui.render(); await ui.key('r');
  async function until(text) {
    for (let i = 0; i < 400; i++) { if (ui.render().includes(text)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('UI missing: ' + text + '\n' + ui.render());
  }
  await until('принять результат'); await ui.key('a'); await until('Публикация принятого результата');
  assert.equal(status(f.profile, f.id).status, 'accepted');
  assert.equal(status(f.profile, f.id).gitPublication, undefined);
  await ui.key('q'); assert.equal(status(f.profile, f.id).gitPublication, undefined);
  ui.render(); await ui.key('u'); await until('m сообщение');
  await ui.key('ь'); await ui.key('\x15');
  for (const letter of 'йфпы') await ui.key(letter);
  await ui.key('\x1b[1087u');
  assert.match(ui.render(), /йфпып▏/); // Cyrillic typing stays text, including Kitty events.
  await ui.key('\x1b[1075;5u'); // Ctrl+г is the physical Ctrl+u chord.
  assert(!ui.render().includes('йфпып'));
  await ui.key('Добавить проверенную CSV-фичу'); await ui.key('\r');
  await until('Enter опубликовать'); assert.match(ui.render(), /Добавить проверенную CSV-фичу/);
  assert.equal(status(f.profile, f.id).gitPublication, undefined);
  await ui.key('\r'); await until('c очистка после merge');
  assert.equal(status(f.profile, f.id).delivery.status, 'done');
  assert.match(await git(path.join(f.feature, 'app'), 'log', '-1', '--format=%s'), /Добавить проверенную CSV-фичу/);
});

test('one Markdown reader handles gg/G; closing never approves; stale visible plan cannot start a worker', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  fs.appendFileSync(path.join(path.dirname(f.task), 'plan.md'), '\n' + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.\n`).join('\n'));
  await prepare(f.profile, f.task);
  const ui = await screen(t, f);
  assert.match(ui.render(), /план готов/);
  await ui.key('\r'); ui.render(); await ui.key('p');
  assert.match(ui.render(), /утвердить этот план/);
  await ui.key('G'); assert(!ui.render().includes('Demo plan'));
  await ui.key('g'); await ui.key('g'); assert.match(ui.render(), /Demo plan/);
  await ui.key('q'); assert.equal(status(f.profile, f.id).status, 'prepared');
  await ui.key('p'); ui.render();
  fs.appendFileSync(path.join(path.dirname(f.task), 'plan.md'), '\nChanged scope.\n');
  await prepare(f.profile, f.task, { replace: true });
  await ui.key('a'); assert.match(ui.render(), /exact prepared digest/);
  assert.equal(status(f.profile, f.id).status, 'prepared');
});

test('installer preserves OpenCode launcher/profile and assigns separate pi state', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.commandCenter, 'start'), 'existing OpenCode launcher');
  const before = fs.readFileSync(f.profile, 'utf8');
  const result = install({ source: f.profile, model: 'provider/glm-5.3-flash' });
  assert.equal(fs.readFileSync(f.profile, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.commandCenter, 'start'), 'utf8'), 'existing OpenCode launcher');
  const p = loadProfile(result.profile);
  assert.equal(p.stateRoot, path.join(f.commandCenter, '.pi/cc-state'));
  assert.equal(p.agentRuntime.kind, 'pi'); assert.match(fs.readFileSync(result.launcher, 'utf8'), /--profile/);
  assert.throws(() => install({ source: f.profile, model: 'provider/model' }), /preserved/);
});

test('runtime adapter preserves OpenCode argv and uses frozen pi role models', () => {
  const options = { directory: '/feature', role: 'builder', model: 'oc/model', session: 'saved' };
  assert.deepEqual(agentCommand({ opencode: ['opencode'] }, options), ['opencode', 'run', '--dir', '/feature', '--agent', 'builder', '--format', 'json', '--session', 'saved', '--model', 'oc/model']);
  const pi = agentCommand({ agentRuntime: { kind: 'pi', command: ['node', 'worker.mjs'] }, pi: { model: 'pi/default', models: { builder: 'pi/builder' } } }, options);
  assert.equal(pi.at(-1), 'pi/builder');
});

test('new Planner leaves all post-replacement work to session_start and exposes no human approval tools', async t => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const previous = process.env.CC_PI_PROFILE; process.env.CC_PI_PROFILE = f.profile;
  t.after(() => { if (previous === undefined) delete process.env.CC_PI_PROFILE; else process.env.CC_PI_PROFILE = previous; });
  const commands = new Map(), tools = [], events = new Map(); let replaced = false;
  const guard = () => { assert.equal(replaced, false, 'Old extension context used after newSession'); };
  await extension({ registerTool(tool) { tools.push(tool.name); }, registerCommand(name, spec) { commands.set(name, spec); }, on(name, cb) { events.set(name, cb); },
    appendEntry: guard, setActiveTools: guard, sendMessage: guard });
  await commands.get('plan-new').handler('', { async waitForIdle() {}, async newSession() { replaced = true; return { cancelled: false }; } });
  assert.equal(replaced, true);
  assert(events.has('session_start'));
  assert(commands.has('cc-stats'));
  assert(!tools.some(x => ['approve', 'accept', 'runUserCommand', 'cc_run', 'bash', 'dev_run'].includes(x)));
});
