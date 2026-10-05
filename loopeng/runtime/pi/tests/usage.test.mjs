import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageReader, summarizeUsage, usageDocument, pricing } from '../lib/usage.mjs';

const model = 'zai/glm-5.3-flash';
const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180,
  reasoning: 7, cacheWrite1h: 4, cost: { total: 999 } };
const rates = { currency: 'USD', models: { [model]: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 2.5 } } };
let serial = 0;
function entry(type, fields = {}, parentId = null) {
  const n = ++serial;
  return { type, id: `entry-${n}`, timestamp: new Date(1700000000000 + n).toISOString(), parentId, ...fields };
}
const answer = (parent, extra = {}) => entry('message', { message: { role: 'assistant', provider: 'zai', model: 'glm-5.3-flash',
  content: [{ type: 'text', text: 'PRIVATE ANSWER MUST NOT ENTER STATISTICS' }], usage, stopReason: 'stop', ...extra } }, parent?.id);
const binding = (parent, taskID, claimPlanning = false, role = 'planner') => entry('custom', { customType: 'cc-state', data: { role, taskID, claimPlanning } }, parent?.id);
function write(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = { commandCenter: root, stateRoot: path.join(root, '.pi/cc-state'), pi: { pricingFile: 'model-prices.json' } };
  fs.writeFileSync(path.join(root, 'model-prices.json'), JSON.stringify(rates));
  const session = (where, name, entries, sessionID = name) => {
    const file = path.join(root, where, `${name}.jsonl`);
    write(file, [{ type: 'session', id: sessionID, version: 3, cwd: root }, ...entries]);
    return file;
  };
  return { root, profile, session, read: createUsageReader(profile) };
}
const total = (snapshot, id) => summarizeUsage(snapshot.records, snapshot.prices, id);

test('CC and task totals include Planner, Orchestrator, all workers, failed usage and optional KB exactly once', t => {
  const f = setup(t), planning = answer(), prepared = binding(planning, 'alpha', true), planned = answer(prepared);
  const other = binding(planned, 'beta', false, 'orchestrator'), discussion = answer(other);
  f.session('.pi/sessions', 'foreground', [planning, prepared, planned, other, discussion]);
  for (const role of ['builder', 'reviewer', 'explorer', 'execution-reviewer']) f.session(`.pi/cc-state/alpha/pi-sessions/${role}`, role, [answer(null, role === 'builder' ? { stopReason: 'error' } : {})]);
  f.session('.pi/cc-state/alpha/knowledge-update/pi-sessions/builder', 'kb', [answer()]);
  const unbound = answer(); f.session('.pi/sessions', 'unbound', [unbound]);
  const s = f.read(), all = total(s), alpha = total(s, 'alpha');
  assert.equal(all.responses, 9); assert.equal(all.total, 9 * 180);
  assert.equal(alpha.responses, 7); assert.equal(alpha.total, 7 * 180);
  assert.equal(alpha.roles.find(x => x.name === 'builder · KB').total, 180);
  assert.equal(alpha.failed, 1);
  assert.equal(total(s, 'beta').total, 180);
  assert.equal(all.tasks.find(x => x.name === '').total, 180);
  assert.equal(all.tokens.output, 9 * 20, 'reasoning is already included in output');
  assert.equal(all.tokens.cacheWrite, 9 * 10, '1h write is already included');
  assert(Math.abs(all.cost - 9 * 0.00033) < 1e-12, 'manual prices replace SDK cost estimates');
  assert(!JSON.stringify(s).includes('PRIVATE ANSWER'));
});

test('resumes, fork copies and branch rewrites deduplicate shared history but retain newly billed responses', t => {
  const f = setup(t), original = answer(), claimed = binding(original, 'alpha', true);
  f.session('.pi/sessions', '003-original', [original, claimed]);
  const branchReply = answer(original), newClaim = binding(branchReply, 'beta', true), secondReply = answer(newClaim);
  f.session('.pi/sessions', '001-fork', [{ ...original, parentId: null }, branchReply, newClaim, secondReply]);
  f.session('.pi/sessions', '004-backup', [original, claimed], '003-original');
  const s = f.read();
  assert.equal(total(s).responses, 3); assert.equal(total(s, 'alpha').responses, 1); assert.equal(total(s, 'beta').responses, 2);
  assert.equal(total(f.read({ force: true })).total, 540, 'refresh cannot bill history again');
});

test('opening a task does not claim unrelated chat; legacy planning remains visible in CC totals', t => {
  const f = setup(t), unbound = answer(), selected = binding(unbound, 'alpha', false, 'orchestrator'), reply = answer(selected);
  f.session('.pi/sessions', 'chat', [unbound, selected, reply]);
  const older = answer(), legacy = binding(older, 'beta'), later = answer(legacy);
  f.session('.pi/sessions', 'legacy', [older, legacy, later]);
  const s = f.read();
  assert.equal(total(s, 'alpha').responses, 1); assert.equal(total(s, 'beta').responses, 1);
  assert.equal(total(s).tasks.find(x => x.name === '').responses, 2);
});

test('compaction and branch-summary usage follow the model in their branch; custom summaries remain unpriced', t => {
  const f = setup(t), change = entry('model_change', { provider: 'zai', modelId: 'glm-5.3-flash' });
  const a = answer(change), compact = entry('compaction', { usage }, a.id);
  const summary = entry('branch_summary', { usage }, compact.id);
  const custom = entry('compaction', { usage, fromHook: true }, summary.id);
  const missing = entry('compaction', {}, custom.id);
  f.session('.pi/sessions', 'compact', [change, a, compact, summary, custom, missing]);
  const s = f.read(), all = total(s);
  assert.equal(all.total, 720); assert.equal(all.responses, 1); assert.equal(all.auxiliary, 4);
  assert.equal(all.models.find(x => x.name === model).total, 540);
  assert.equal(all.unknownPriceTokens, 180); assert.equal(all.missingUsage, 1); assert.equal(all.cost, null);
  assert.match(usageDocument(s), /Usage отсутствует/);
});

test('manual tariffs reload without new task approval; missing rates are unknown while explicit zero is free', t => {
  const f = setup(t); f.session('.pi/sessions', 'chat', [answer()]);
  const file = path.join(f.root, 'model-prices.json');
  fs.writeFileSync(file, JSON.stringify({ currency: 'EUR', models: { [model]: { input: 2, output: null, cacheRead: 0, cacheWrite: 0 } } }));
  let s = f.read(), a = total(s);
  assert.equal(a.cost, null); assert.equal(a.knownCost, 0.0002); assert.equal(a.unknownPriceTokens, 20);
  assert.match(usageDocument(s), /Без тарифа: 20/); assert.match(usageDocument(s), /EUR/);
  fs.writeFileSync(file, JSON.stringify({ currency: 'EUR', models: { [model]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
  s = f.read({ force: true }); assert.equal(total(s).cost, 0); assert.equal(total(s).unknownPriceTokens, 0);
  for (const bad of [-1, '2', true]) {
    fs.writeFileSync(file, JSON.stringify({ ...rates, models: { [model]: { input: bad } } }));
    const p = pricing(f.profile); assert.match(p.error, /Тарифы недоступны/); assert.deepEqual(p.models, {});
  }
  fs.writeFileSync(file, '{broken');
  s = f.read({ force: true }); assert.equal(total(s).total, 180); assert.equal(total(s).cost, null); assert(s.warnings.length);
});

test('different provider/model prices stay separate; unreported token fields never imply a known full price', t => {
  const f = setup(t);
  f.session('.pi/sessions', 'chat', [answer(), answer(null, { provider: 'other', model: 'glm-5.3-flash' }), answer(null, { usage: { input: 7, output: 2 } })]);
  const s = f.read(), a = total(s);
  assert.equal(a.models.length, 2); assert.equal(a.unknownPriceTokens, 180);
  assert.equal(a.missingUsage, 1); assert.equal(a.cost, null); assert.equal(a.total, 369);
});

test('incremental accounting handles UTF-8 split appends, truncated writes, corrupt lines and file rewrites', t => {
  const f = setup(t), first = answer();
  const file = f.session('.pi/sessions', 'chat', [first]);
  assert.equal(total(f.read()).total, 180);
  const second = answer(first, { content: [{ type: 'text', text: 'Привет' }] });
  const bytes = Buffer.from(JSON.stringify(second) + '\n'), split = bytes.indexOf(Buffer.from('Привет')) + 1;
  fs.appendFileSync(file, bytes.subarray(0, split));
  let s = f.read({ force: true }); assert.equal(total(s).total, 180); assert(s.warnings.some(x => x.includes('Незавершённых')));
  fs.appendFileSync(file, bytes.subarray(split));
  assert.equal(total(f.read({ force: true })).total, 360);
  fs.appendFileSync(file, 'invalid json\n');
  s = f.read({ force: true }); assert.equal(total(s).total, 360); assert(s.warnings.some(x => x.includes('Повреждённых')));
  f.session('.pi/sessions', 'chat', [answer(null, { content: [{ type: 'text', text: 'rewritten'.repeat(200) }] })]);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  s = f.read({ force: true }); assert.equal(total(s).total, 180); assert.equal(s.warnings.length, 0);
  fs.unlinkSync(file); assert.equal(total(f.read({ force: true })).total, 0);
});

test('full accounting exceeds UI tail/file limits and ignores tool echoes and symlinked files', t => {
  const f = setup(t);
  const first = answer(null, { content: [{ type: 'text', text: 'x'.repeat(200_000) }] });
  const fakeEcho = entry('message', { message: { role: 'toolResult', usage } }, first.id);
  const original = f.session('.pi/sessions', 'large', [first, fakeEcho]);
  for (let i = 0; i < 105; i++) f.session('.pi/cc-state/alpha/pi-sessions/explorer', `explorer-${i}`, [answer()]);
  fs.symlinkSync(original, path.join(f.root, '.pi/sessions/symlink.jsonl'));
  const s = f.read(); assert.equal(total(s).responses, 106); assert.equal(total(s).total, 106 * 180);
  assert.equal(total(s, 'alpha').responses, 105);
});

test('invalid optional pricing paths and broken session directories show partial-data notices without breaking stats', t => {
  const f = setup(t); f.session('.pi/sessions', 'chat', [answer()]);
  fs.writeFileSync(f.profile.stateRoot, 'not a directory');
  f.profile.pi.pricingFile = {};
  const s = f.read();
  assert.equal(total(s).total, 180); assert.equal(total(s).cost, null);
  assert(s.warnings.some(x => x.includes('pi.pricingFile'))); assert(s.warnings.some(x => x.includes('Каталог сессий недоступен')));
  assert.match(usageDocument(s), /Есть неполные данные/);
});
