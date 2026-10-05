import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createControls } from '../tui/command-center.mjs';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare, approve, run, status } from '../lib/controller.mjs';
import { delay } from '../lib/recovery.mjs';
import { jobStatus } from '../lib/background.mjs';
import { git } from '../lib/process.mjs';

async function until(fn) { for (let i = 0; i < 240; i++) { if (fn()) return; await delay(25); } throw new Error('UI condition not reached'); }
async function setup(t, scenario = 'pass', { gitActions = false, runTerminal, runReviewEditor, autoOpen = false } = {}) {
  const f = await fixture({ scenario });
  if (gitActions) {
    const profile = JSON.parse(fs.readFileSync(f.profile));
    profile.git = { allowCommit: true };
    for (const [id, repo] of Object.entries(profile.repositories)) {
      await git(path.join(f.feature, id), 'branch', '-m', `feature/${f.id}`);
      await git(repo.source, 'branch', 'feature/upstream'); repo.baseRef = 'feature/upstream';
    }
    writeJSON(f.profile, profile);
  }
  await prepare(f.profile, f.task);
  const env = { profile: process.env.CC_PROFILE, worker: process.env.CC_WORKER_ROLE };
  process.env.CC_PROFILE = f.profile; delete process.env.CC_WORKER_ROLE;
  const disposers = [], toasts = [], created = [], sent = [], navigated = []; let current, command, actionCommand, agentsCommand, reviewCommand;
  const clear = () => { const previous = current; current = undefined; previous?.close?.(); };
  const api = { renderer: { width: 100, height: 40 },
    route: { current: { name: 'home' }, navigate(name, params) { this.current = { name, params }; navigated.push({ name, params }); } },
    client: { session: {
      async create(args) { const id = `new-session-${created.length + 1}`; created.push({ ...args, id }); return { data: { id } }; },
      async command(args) { sent.push(args); return { data: {} }; },
    } },
    ui: { dialog: { get open() { return !!current; }, clear, replace(render, close) { clear(); current = { ...render(), close }; } },
      DialogSelect: props => ({ type: 'select', props }), DialogConfirm: props => ({ type: 'confirm', props }),
      DialogAlert: () => { throw new Error('Paginated alerts must not be used for documents'); }, DialogPrompt: props => ({ type: 'prompt', props }), toast: value => toasts.push(value) },
    keymap: { registerLayer(layer) { command = layer.commands[0].run; actionCommand = layer.commands[1].run; agentsCommand = layer.commands[2].run; reviewCommand = layer.commands[3].run; } },
    lifecycle: { onDispose(fn) { disposers.push(fn); } },
  };
  const documents = [], reviews = [];
  await createControls(api, { runTerminal, runReviewEditor, autoOpen, openReview: (review, position) => new Promise(resolve => {
    reviews.push(review); clear();
    current = { type: 'review', props: { review, position, onConfirm() {}, onAction: resolve, onCancel: () => resolve(false) }, close: () => resolve(false) };
  }), openDocument: document => new Promise(resolve => {
    documents.push(document); clear();
    current = { type: 'document', props: { ...document,
      onConfirm: () => { if (!document.actions) resolve(Boolean(document.continueLabel)); }, onAction: value => resolve(value), onCancel: () => resolve(false) }, close: () => resolve(false) };
  }) });
  t.after(() => {
    disposers.forEach(fn => fn()); clear();
    if (env.profile === undefined) delete process.env.CC_PROFILE; else process.env.CC_PROFILE = env.profile;
    if (env.worker === undefined) delete process.env.CC_WORKER_ROLE; else process.env.CC_WORKER_ROLE = env.worker;
    fs.rmSync(f.base, { recursive: true, force: true });
  });
  return { ...f, toasts, api, created, sent, navigated, documents, reviews, async menu() { void command(); await until(() => current?.type === 'select'); },
    async inbox() { void actionCommand(); await until(() => current?.type === 'document'); },
    async agents() { void agentsCommand(); await until(() => current?.type === 'select'); },
    async review() { void reviewCommand(); await until(() => current?.type === 'review'); },
    async reviewAction(action, file) { current.props.onAction({ action, file, position: { index: 0, seen: [0] } }); clear(); await delay(1); },
    async act(value) { const old = current; assert(old.props.actions.some(x => x.value === value)); old.props.onAction(value); clear(); await delay(1); },
    get dialog() { return current; },
    async choose(value) { current.props.onSelect({ value }); await delay(1); },
    async confirm(yes = true) { const old = current; if (yes) old.props.onConfirm(); else old.props.onCancel?.(); clear(); await delay(1); },
    async enter(value) { current.props.onConfirm(value); await delay(1); },
    async readDocument() { while (current?.type === 'document') { await this.confirm(); } },
  };
}

test('workspace list opens the current plan directly without approving it', async t => {
  const f = await setup(t);
  await f.agents();
  const option = f.dialog.props.options.find(item => item.value.id === f.id);
  assert.match(option.description, /Утвердить план/);
  await f.choose(option.value); await until(() => f.dialog?.type === 'document');
  assert.match(f.dialog.props.title, /План/); assert.equal(status(f.profile, f.id).status, 'prepared');
  await f.confirm(false); assert.equal(status(f.profile, f.id).status, 'prepared');
  assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
});

test('workspace list opens a Builder request directly; Later preserves its attention status', async t => {
  const f = await setup(t, 'user-action');
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.agents(); await f.choose(f.dialog.props.options.find(item => item.value.id === f.id).value);
  await until(() => f.dialog?.type === 'document'); assert(f.dialog.props.actions);
  await f.act('later'); await f.agents();
  assert.equal(f.dialog.props.options[0].value.attention, true);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
});

test('workspace list navigates to Planner questions without creating a session or sending a reply', async t => {
  const f = await setup(t);
  f.api.client.session.status = async () => ({ data: { 'planner-id': { type: 'busy' } } });
  f.api.client.session.get = async () => ({ data: { directory: f.commandCenter, title: 'Planner question', agent: 'planner' } });
  f.api.client.question = { list: async () => ({ data: [{ sessionID: 'planner-id' }] }) };
  f.api.client.permission = { list: async () => ({ data: [] }) };
  await f.agents(); await f.choose(f.dialog.props.options.find(item => item.value.id === 'planner-id').value);
  assert.deepEqual(f.navigated.at(-1), { name: 'session', params: { sessionID: 'planner-id' } });
  assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
});

test('one action card executes a command and automatically sends success after the final command', async t => {
  const executed = [];
  const f = await setup(t, 'user-action', { runTerminal: async (renderer, command) => { executed.push(command); return { code: 0 }; } });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.inbox(); assert.equal(f.dialog.type, 'document'); assert.match(f.dialog.props.content, /sudo --version/);
  f.dialog.props.onConfirm(); await delay(1); assert.equal(executed.length, 0, 'Enter on an arriving card cannot authorize execution');
  await f.act('later'); assert.equal(executed.length, 0);
  await f.inbox(); await f.act('execute'); await until(() => f.dialog?.type === 'document');
  assert.equal(executed.length, 1); assert.match(f.dialog.props.content, /Команда 2 из 2/);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
  await f.act('execute'); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  assert.equal(executed.length, 2);
  const result = status(f.profile, f.id); assert.equal(result.status, 'ready_for_user');
  assert.equal(result.userActions[0].response.outcome, 'completed'); assert.match(result.userActions[0].response.summary, /код 0/);
  assert.equal(result.userActions[0].response.output, '');
  assert.equal(f.documents.filter(d => d.actions).length, 3, 'Only one card per command, plus the explicitly reopened card');
  assert.equal(f.toasts.some(x => x.variant === 'error'), false);
});

test('failed command returns to the same action card; retry never repeats successful commands', async t => {
  const executed = []; let fail = true;
  const f = await setup(t, 'user-action', { runTerminal: async (renderer, command) => {
    executed.push(command.index); return { code: command.index === 1 && fail ? 7 : 0 };
  } });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.inbox(); await f.act('execute'); await until(() => f.dialog?.type === 'document');
  await f.act('execute'); await until(() => f.dialog?.type === 'document');
  assert.match(f.dialog.props.content, /код 7/); assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
  fail = false; await f.act('execute'); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  assert.deepEqual(executed, [0, 1, 1]); assert.equal(status(f.profile, f.id).status, 'ready_for_user');
});

test('new request appears automatically once; Later preserves it and direct inbox reopens it', async t => {
  const f = await setup(t, 'user-action', { autoOpen: true });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  if (f.dialog?.type === 'select') f.api.ui.dialog.clear();
  await until(() => f.dialog?.type === 'document'); assert(f.dialog.props.actions);
  await f.act('later'); await delay(1300); assert.equal(f.dialog, undefined);
  assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
  await f.inbox(); await f.act('later');
});

test('one click returns a failed command to Builder with its actual exit code', async t => {
  let executions = 0;
  const f = await setup(t, 'user-action', { runTerminal: async () => { executions++; return { code: 7 }; } });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.inbox(); await f.act('execute'); await until(() => f.dialog?.type === 'document');
  await f.act('failed'); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  const response = status(f.profile, f.id).userActions[0].response;
  assert.equal(executions, 1); assert.equal(response.outcome, 'failed'); assert.match(response.summary, /код 7/);
});

test('action card binds the displayed request; command edits cannot inherit the click', async t => {
  let executions = 0;
  const f = await setup(t, 'user-action', { runTerminal: async () => { executions++; return { code: 0 }; } });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.inbox();
  const file = path.join(f.stateDir, 'pending-user-action.json');
  const request = JSON.parse(fs.readFileSync(file)); request.request.commands[0].command = 'echo changed'; writeJSON(file, request);
  await f.act('execute'); await until(() => f.toasts.some(x => x.variant === 'error'));
  assert.equal(executions, 0); assert.equal(status(f.profile, f.id).status, 'waiting_for_user_action');
});

test('TUI approval remains prepared until an explicit confirmation and binds the displayed digest', async t => {
  const f = await setup(t);
  await f.menu(); await f.choose({ type: 'task', id: f.id }); await f.choose('approve'); await f.readDocument();
  assert.equal(f.dialog.type, 'confirm'); assert.equal(status(f.profile, f.id).status, 'prepared');
  await f.confirm(false); assert.equal(status(f.profile, f.id).status, 'prepared');
  await f.menu(); await f.choose({ type: 'task', id: f.id }); await f.choose('approve'); await f.readDocument();
  await f.confirm(); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  assert.equal(status(f.profile, f.id).status, 'ready_for_user');
  assert.equal(f.toasts.some(x => x.variant === 'error'), false);
});

test('new planning always creates an independent session even when an older chat is open', async t => {
  const f = await setup(t);
  f.api.route.current = { name: 'session', params: { sessionID: 'previous-task' } };
  const saved = path.join(f.commandCenter, '.opencode-loop-state/interactive-session.json');
  fs.writeFileSync(saved, JSON.stringify({ session: 'previous-task' }));
  for (const text of ['Add images', 'Add pagination']) {
    await f.menu(); await f.choose({ type: 'new-plan' }); await f.enter(text);
    await until(() => f.sent.length === f.created.length && f.sent.at(-1)?.arguments === text);
  }
  assert.deepEqual(f.created.map(x => x.title), ['Add images', 'Add pagination']);
  assert.deepEqual(f.sent.map(x => x.sessionID), ['new-session-1', 'new-session-2']);
  assert(f.sent.every(x => x.command === 'cc-plan'));
  assert.equal(f.api.route.current.params.sessionID, 'new-session-2');
  assert.equal(JSON.parse(fs.readFileSync(saved)).session, 'new-session-2');
});

test('continuing planning sends only to the explicitly selected current conversation', async t => {
  const f = await setup(t);
  f.api.route.current = { name: 'session', params: { sessionID: 'current-task' } };
  await f.menu();
  assert(f.dialog.props.options.some(x => x.value.type === 'continue-plan'));
  await f.choose({ type: 'continue-plan' }); await f.enter('Clarify acceptance criteria');
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].sessionID, 'current-task');
  assert.equal(f.created.length, 0); assert.equal(f.navigated.length, 0);
});

test('cancelling a new task or failing to create its session never sends to an older conversation', async t => {
  const f = await setup(t);
  await f.menu(); assert(!f.dialog.props.options.some(x => x.value.type === 'continue-plan'));
  await f.choose({ type: 'new-plan' }); await f.enter(null);
  assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
  f.api.route.current = { name: 'session', params: { sessionID: 'previous-task' } };
  f.api.client.session.create = async () => ({ error: 'offline' });
  await f.menu(); await f.choose({ type: 'new-plan' }); await f.enter('A new task');
  await until(() => f.toasts.some(x => x.variant === 'error'));
  assert.equal(f.sent.length, 0);
  assert.equal(f.api.route.current.params.sessionID, 'previous-task');
});

test('single-card refusal sends a human response without executing any command', async t => {
  const f = await setup(t, 'user-action');
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.menu(); await f.choose({ type: 'task', id: f.id }); await until(() => f.dialog?.type === 'document');
  await f.act('declined'); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  const result = status(f.profile, f.id); assert.equal(result.status, 'ready_for_user');
  assert.equal(result.userActions[0].response.outcome, 'declined');
  assert.equal(fs.existsSync(path.join(f.feature, 'user-action-executed.txt')), false);
});

test('review menu opens file patches; Enter and closing cannot accept; explicit acceptance requires confirmation', async t => {
  const f = await setup(t); await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.menu(); await f.choose({ type: 'task', id: f.id });
  assert.equal(f.dialog.props.options.find(option => option.value === 'review').title, 'Ревью изменений');
  assert(!f.dialog.props.options.some(option => option.value === 'accept'));
  await f.choose('review'); await until(() => f.dialog?.type === 'review');
  assert(f.dialog.props.review.files.some(file => file.path === 'new.txt' && file.patch.includes('New file in round')));
  f.dialog.props.onConfirm(); assert.equal(status(f.profile, f.id).status, 'ready_for_user');
  await f.confirm(false); assert.equal(status(f.profile, f.id).status, 'ready_for_user');
  await f.review(); await f.reviewAction('accept'); await until(() => f.dialog?.type === 'confirm');
  assert(!f.dialog.props.message.includes('Fingerprint'));
  assert.equal(status(f.profile, f.id).status, 'ready_for_user'); assert.equal(f.dialog.type, 'confirm');
  await f.confirm(false); await until(() => f.dialog?.type === 'review');
  assert.deepEqual(f.dialog.props.position.seen, [0]);
  await f.reviewAction('accept'); await until(() => f.dialog?.type === 'confirm');
  await f.confirm(); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  assert.equal(status(f.profile, f.id).status, 'accepted');
});

test('review feedback includes the selected file and restarts the loop after one form submission', async t => {
  const f = await setup(t); await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.review(); const file = f.dialog.props.review.files.find(item => item.path === 'new.txt');
  await f.reviewAction('feedback', file); await until(() => f.dialog?.type === 'prompt');
  await f.enter('Add an example to this file.'); await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  const result = status(f.profile, f.id);
  assert.match(result.feedback.find(item => item.source === 'user').text, /library\/new.txt\n\nAdd an example/);
  assert.equal(result.status, 'ready_for_user'); assert.equal(result.round, 2);
});

test('task history and live view only read messages and preserve pipeline state', async t => {
  const f = await setup(t); await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  const before = status(f.profile, f.id); const reads = [];
  f.api.client.session.messages = async args => { reads.push(args); return { data: [{info:{role:'assistant'},parts:[{type:'reasoning',text:'test reasoning'},{type:'text',text:'test update'}]}] }; };
  await f.menu(); await f.choose({type:'task',id:f.id}); await f.choose('watch'); await until(() => f.dialog?.type === 'document');
  assert(f.dialog.props.live); assert(f.dialog.props.content.includes('test reasoning'));
  await f.dialog.props.refresh(); assert(reads.length >= 2); await f.confirm(false);
  await f.menu(); await f.choose({type:'task',id:f.id}); await f.choose('history'); await until(() => f.dialog?.props.title?.startsWith('История агентов'));
  const option = f.dialog.props.options[0]; await f.choose(option.value); await until(() => f.dialog?.type === 'document');
  assert.equal(f.dialog.props.live, false); await f.confirm(false); await until(() => f.dialog?.type === 'select');
  await f.confirm(false); assert.deepEqual(status(f.profile, f.id), before); assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
});

test('editor returns to the selected review after success or error without accepting or launching a worker', async t => {
  const opened = [];
  const f = await setup(t, 'pass', { runReviewEditor: async (_, review, options) => {
    opened.push({ review, ...options }); if (opened.length === 2) throw new Error('editor unavailable');
  } });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.review(); const before = status(f.profile, f.id), file = f.dialog.props.review.files[0];
  await f.reviewAction('editor', file); await until(() => f.dialog?.type === 'review');
  assert.deepEqual(opened[0].file, file); assert.deepEqual(f.dialog.props.position.seen, [0]);
  await f.reviewAction('editor-all', file); await until(() => f.dialog?.type === 'review');
  assert.equal(opened[1].file, undefined); assert.match(f.toasts.at(-1).message, /editor unavailable/);
  assert.deepEqual(status(f.profile, f.id), before); assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
});

test('review acceptance refuses files changed after the preview was opened', async t => {
  const f = await setup(t); await approve(f.profile, f.id, status(f.profile, f.id).digest); await run(f.profile, f.id);
  await f.review(); fs.appendFileSync(path.join(f.feature, 'app/value.txt'), 'changed after preview\n');
  await f.reviewAction('accept'); await until(() => f.dialog?.type === 'confirm'); await f.confirm();
  await until(() => f.toasts.some(item => item.variant === 'error'));
  assert.equal(status(f.profile, f.id).status, 'ready_for_user'); assert.match(f.toasts.at(-1).message, /изменения|Изменения/);
});


test('TUI reviewed commit requires confirmation and leaves user acceptance pending', async t => {
  const f = await setup(t, 'pass', { gitActions: true });
  await approve(f.profile, f.id, status(f.profile, f.id).digest); const ready = await run(f.profile, f.id);
  for (const confirmed of [false, true]) {
    await f.menu(); await f.choose({ type: 'task', id: f.id });
    assert(f.dialog.props.options.some(x => x.value === 'commit-reviewed'));
    await f.choose('commit-reviewed'); await until(() => f.dialog?.type === 'document'); await f.readDocument();
    assert.equal(f.dialog.type, 'confirm'); assert.equal(status(f.profile, f.id).gitPublication, undefined);
    await f.confirm(confirmed);
  }
  await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  const result = status(f.profile, f.id);
  assert.equal(result.status, 'ready_for_user'); assert.equal(result.reviewedCommit.status, 'done');
  assert.equal(result.digest, ready.digest); assert.equal(result.acceptedAt, undefined);
  assert.equal(f.toasts.some(x => x.variant === 'error'), false);
});

test('TUI base refresh displays target commits, permits cancellation and resets approval', async t => {
  const f = await setup(t, 'pass', { gitActions: true }), initial = status(f.profile, f.id);
  await approve(f.profile, f.id, initial.digest);
  const repo = initial.snapshot.repos[0], tree = (await git(repo.source, 'rev-parse', 'HEAD^{tree}')).trim();
  const to = (await git(repo.source, 'commit-tree', tree, '-p', repo.base, '-m', 'Prepared dependency')).trim();
  await git(repo.source, 'update-ref', 'refs/heads/feature/upstream', to, repo.base);
  for (const confirmed of [false, true]) {
    await f.menu(); await f.choose({ type: 'task', id: f.id });
    assert(f.dialog.props.options.some(x => x.value === 'refresh-base'));
    await f.choose('refresh-base'); await until(() => f.dialog?.type === 'document'); await f.readDocument();
    assert.equal(f.dialog.type, 'confirm'); assert.equal(status(f.profile, f.id).status, 'approved');
    assert.equal((await git(repo.root, 'rev-parse', 'HEAD')).trim(), repo.base);
    await f.confirm(confirmed);
  }
  await until(() => jobStatus(f.profile, f.id)?.status === 'finished');
  const result = status(f.profile, f.id);
  assert.equal(result.status, 'prepared', result.error); assert.equal(result.approved, undefined);
  assert.equal(result.snapshot.repos[0].base, to); assert.notEqual(result.digest, initial.digest);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'mock-agents.jsonl')), false);
  assert.equal(f.toasts.some(x => x.variant === 'error'), false);
});

test('large plans use one formatted document; leaving it never approves or starts work', async t => {
  const f = await setup(t);
  const file = path.join(f.stateDir, 'state.json'), state = JSON.parse(fs.readFileSync(file));
  // Display fixture only: preserve a large Markdown document byte-for-byte in the reader payload.
  state.snapshot.plan = '# Большой план\n\n' + '## Раздел\n\n**Требование** и `код`.\n\n'.repeat(80);
  fs.writeFileSync(file, JSON.stringify(state));
  await f.menu(); await f.choose({ type: 'task', id: f.id }); await f.choose('approve');
  assert.equal(f.documents.length, 1); assert.equal(f.dialog.type, 'document');
  assert(f.documents[0].content.includes(state.snapshot.plan));
  assert(f.documents[0].content.includes(state.digest));
  assert(f.documents[0].content.includes('## Согласованные действия'));
  await f.confirm(false);
  assert.equal(status(f.profile, f.id).status, 'prepared'); assert.equal(jobStatus(f.profile, f.id), undefined);
});

test('command viewer opens one deduplicated document and refresh remains read-only', async t => {
  const f = await setup(t), file = path.join(f.stateDir, 'commands.jsonl');
  const command = { id: 'call-1', command: 'ls -la', actor: 'builder', phase: 'requested' };
  fs.writeFileSync(file, [command, { ...command, phase: 'started' }, { ...command, phase: 'finished', exit_code: 0 }].map(JSON.stringify).join('\n') + '\n');
  await f.menu(); await f.choose({ type: 'task', id: f.id }); await f.choose('commands');
  assert.equal(f.documents.length, 1); const document = f.documents[0];
  assert.equal(document.content.split('ls -la').length - 1, 1);
  fs.appendFileSync(file, JSON.stringify({ ...command, id: 'call-2', command: 'git status' }) + '\n');
  assert(document.refresh().content.includes('git status'));
  await f.confirm(); assert.equal(status(f.profile, f.id).status, 'prepared'); assert.equal(jobStatus(f.profile, f.id), undefined);
});
