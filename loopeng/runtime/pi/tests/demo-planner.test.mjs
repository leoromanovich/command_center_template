import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import extension from '../extension.mjs';
import { setupDemo } from '../setup-demo.mjs';

test('demo Planner prepares once, preserves existing tasks after profile changes and labels scripted mode', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-demo-planner-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const f = await setupDemo(path.join(parent, 'fixture'), 'no-action');
  const previous = process.env.CC_PI_PROFILE;
  process.env.CC_PI_PROFILE = f.profile;
  t.after(() => { if (previous === undefined) delete process.env.CC_PI_PROFILE; else process.env.CC_PI_PROFILE = previous; });
  let provider, widget, binding;
  const tools = new Map(), events = new Map();
  await extension({
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    registerProvider(name, config) { assert.equal(name, 'cc-demo'); provider = config; },
    on(name, callback) { events.set(name, callback); }, appendEntry(type, data) { if (type === 'cc-state') binding = data; }, setActiveTools() {}, sendMessage() {},
  });
  t.after(() => events.get('session_shutdown')());
  const prompt = () => provider.streamSimple({ ...provider.models[0], api: provider.api, provider: 'cc-demo' }, {
    messages: [{ role: 'user', content: 'Создай txt-файл: привет потомки', timestamp: Date.now() }],
  }, {}).result();

  const first = await prompt();
  assert.equal(first.stopReason, 'toolUse');
  const call = first.content.find(x => x.type === 'toolCall');
  assert.equal(call.name, 'cc_prepare');
  await tools.get(call.name).execute(call.id, call.arguments);
  assert.deepEqual(binding, { role: 'planner', taskID: f.id, claimPlanning: true });
  const statePath = path.join(f.stateDir, 'state.json');
  const prepared = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const profile = JSON.parse(fs.readFileSync(f.profile, 'utf8'));
  profile.maxRounds += 1;
  fs.writeFileSync(f.profile, JSON.stringify(profile));

  for (const state of [prepared, { ...prepared, status: 'accepted', delivery: { status: 'done' } }]) {
    const before = JSON.stringify(state);
    fs.writeFileSync(statePath, before);
    const reply = await prompt();
    assert.equal(reply.stopReason, 'stop', reply.errorMessage);
    assert(!reply.content.some(x => x.type === 'toolCall'));
    const text = reply.content.filter(x => x.type === 'text').map(x => x.text).join('');
    assert.match(text, /DEMO: фиксированный сценарий/);
    assert.match(text, /--profile/);
    assert.match(text, /уже существует.*\/tasks/s);
    if (state.status === 'accepted') assert.match(text, /опубликована/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
  }
  await events.get('session_start')({}, {
    mode: 'tui', model: { provider: 'cc-demo' }, sessionManager: { getBranch: () => [] },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {}, setWidget(_key, value) { widget = value; } },
  });
  assert.match(widget[0], /DEMO: фиксированный сценарий/);
  assert(widget.some(line => line.includes('/tasks')));
});
