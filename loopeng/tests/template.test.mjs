import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeConfig, initExample, materializeProfile, assertSources } from '../scripts/cc.mjs';
import { templateFixture } from './fixture.mjs';
import { prepare } from '../runtime/core/lib/controller.mjs';
import { createUsageReader, summarizeUsage } from '../runtime/pi/lib/usage.mjs';
import { roleTools } from '../runtime/pi/lib/tools.mjs';

test('a relocated clean template resolves runtime, sources, UI and profile from its own checkout', async t => {
  const f = templateFixture(t, { configured: true });
  assertSources(f.profile);
  assert.equal(f.profile.commandCenter, f.root);
  assert.equal(f.profile.agentRuntime.command[1], path.join(f.root, 'runtime/pi/worker.mjs'));
  for (const role of ['builder', 'reviewer', 'explorer', 'execution-reviewer']) assert.equal(f.profile.pi.models[role], 'zai/glm-5.3-flash');
  for (const file of f.profile.sandbox.contextFiles) assert(fs.statSync(path.join(f.root, file)).isFile());
  const result = spawnSync('./start', ['--help'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /New Planner chat/);
  const load = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./runtime/pi/extension.mjs"); await import("./runtime/core/lib/knowledge.mjs"); console.log("ok")'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(load.status, 0, load.stderr);
  const before = fs.readFileSync(f.profile.filename, 'utf8');
  materializeProfile(f.root);
  assert.equal(fs.readFileSync(f.profile.filename, 'utf8'), before);
  assert.equal(fs.statSync(f.profile.filename).mode & 0o777, 0o600);
});

test('local override replaces repository scope, preserves model defaults and fails closed on host execution', t => {
  const f = templateFixture(t, { configured: true });
  const repo = f.profile.repositories.service;
  const local = path.join(f.root, 'cc.local.json');
  fs.writeFileSync(local, JSON.stringify({ repositories: { custom: { ...repo, worktree: 'custom' } }, pi: { thinkingLevel: 'medium' } }));
  const p = materializeProfile(f.root);
  assert.deepEqual(Object.keys(p.repositories), ['custom']);
  assert.equal(p.pi.thinkingLevel, 'medium'); assert.equal(p.pi.model, 'zai/glm-5.3-flash');
  fs.writeFileSync(local, JSON.stringify({ sandbox: { kind: 'host' } }));
  assert.throws(() => materializeProfile(f.root), /requires sandbox.kind=docker/);
  fs.writeFileSync(local, JSON.stringify({ devRun: { enabled: true } }));
  assert.throws(() => materializeProfile(f.root), /devRun.enabled=false/);
  assert.throws(() => mergeConfig({}, JSON.parse('{"__proto__":{"polluted":true}}')), /Invalid config key/);
});

test('example initialization is separate, preserves edits/history and shares only runtime', async t => {
  const f = templateFixture(t), rootConfig = fs.readFileSync(path.join(f.root, 'cc.config.json'), 'utf8');
  const rootProfile = fs.readFileSync(f.profile.filename, 'utf8');
  const p = await initExample(f.root), file = path.join(p.commandCenter, '../repositories/catalog/catalog.py');
  fs.appendFileSync(file, '\n# local work\n');
  const sessions = path.join(p.commandCenter, '.pi/sessions'); fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 'chat.jsonl'), JSON.stringify({ type: 'message', id: 'demo', timestamp: '2026-09-24', message: { role: 'assistant', provider: 'zai', model: 'glm-5.3-flash', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } } }) + '\n');
  assert.equal((await initExample(f.root)).filename, p.filename);
  assert.match(fs.readFileSync(file, 'utf8'), /# local work/);
  assert.equal(fs.readFileSync(path.join(f.root, 'cc.config.json'), 'utf8'), rootConfig);
  assert.equal(fs.readFileSync(f.profile.filename, 'utf8'), rootProfile);
  assert.deepEqual(materializeProfile(f.root).repositories, {});
  assert.equal(p.agentRuntime.command[1], f.profile.agentRuntime.command[1]);
  assert(p.stateRoot.startsWith(p.commandCenter + path.sep));
  for (const name of p.sandbox.contextFiles) assert(fs.statSync(path.join(p.commandCenter, name)).isFile());
  assert.notEqual(p.sandbox.image, f.profile.sandbox.image);
  const rootUsage = createUsageReader(f.profile)(), exampleUsage = createUsageReader(p)();
  assert.equal(summarizeUsage(rootUsage.records, rootUsage.prices).total, 0);
  assert.equal(summarizeUsage(exampleUsage.records, exampleUsage.prices).total, 120);
  const launchHelp = spawnSync('./start', ['--help'], { cwd: p.commandCenter, encoding: 'utf8' });
  assert.equal(launchHelp.status, 0, launchHelp.stderr);
  assert.match(launchHelp.stdout, /--profile/);
});

test('runtime artifacts stay outside Git while independent example sources remain tracked', t => {
  const f = templateFixture(t);
  const git = args => {
    const r = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  git(['init', '-b', 'main']);
  const ignored = ['.pi/cc-profile.json', '.pi/sessions/private.jsonl', '.local/examples/python-catalog/CommandCenter/.pi/sessions/private.jsonl', 'wt/task/repo/file.py', 'cc.local.json', 'model-prices.local.json', '.env', 'runtime/pi/.docker-demo/profile.json'];
  assert.deepEqual(git(['check-ignore', '--', ...ignored]).trim().split('\n'), ignored);
  const visible = git(['ls-files', '--others', '--exclude-standard']).trim().split('\n');
  for (const file of ['start', 'cc.config.json', 'docker/Dockerfile', 'runtime/pi/worker.mjs', 'runtime/core/lib/controller.mjs', 'examples/python-catalog/profile.json', 'examples/python-catalog/repository/catalog.py']) assert(visible.includes(file), file);
  const refusal = spawnSync('./start', ['--demo'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(refusal.status, 1); assert.match(refusal.stderr, /separate example/);
});

test('stats exports CC/task totals using manual prices without requiring source repositories or starting agents', t => {
  const f = templateFixture(t), task = path.join(f.profile.stateRoot, 'cost-check');
  fs.mkdirSync(path.join(task, 'pi-sessions/builder'), { recursive: true });
  fs.writeFileSync(path.join(task, 'state.json'), '{}');
  fs.writeFileSync(path.join(task, 'pi-sessions/builder/session.jsonl'), [
    { type: 'session', id: 'stats-session' },
    { type: 'message', id: 'a', timestamp: '2026-09-24', parentId: null, message: { role: 'assistant', provider: 'zai', model: 'glm-5.3-flash', usage: { input: 1000000, output: 2000000, cacheRead: 3000000, cacheWrite: 4000000 } } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(f.root, 'model-prices.json'), JSON.stringify({ currency: 'USD', models: { 'zai/glm-5.3-flash': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } } }));
  for (const scope of [[], ['cost-check']]) {
    const r = spawnSync('./cc', ['stats', ...scope, '--json'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.scope, scope[0] ?? 'cc'); assert.equal(data.summary.total, 10_000_000); assert.equal(data.summary.cost, 7.3);
  }
  const missing = spawnSync('./cc', ['stats', 'missing', '--json'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Unknown CC task/);
});

test('empty CC explains setup without loading Pi, keeps stats available and refuses task preparation', async t => {
  const f = templateFixture(t);
  assert.deepEqual(f.profile.repositories, {});
  assert(!f.profile.knowledge.some(x => x.startsWith('examples/')));
  assert(!f.profile.sandbox.contextFiles.some(x => x.includes('checks/') || x.startsWith('examples/')));
  const start = spawnSync('./start', [], { cwd: f.root, encoding: 'utf8', env: { ...process.env, PI_PACKAGE_ROOT: '/intentionally/missing/pi' } });
  assert.equal(start.status, 0, start.stderr); assert.match(start.stdout, /репозитории не подключены/); assert.match(start.stdout, /\.\/cc example/);
  assert(!fs.existsSync(path.join(f.root, '.local')));
  const stats = spawnSync('./cc', ['stats', '--json'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(stats.status, 0, stats.stderr); assert.equal(JSON.parse(stats.stdout).summary.total, 0);
  await assert.rejects(() => prepare(f.profile.filename, path.join(f.profile.draftsRoot, 'missing.json')), /Configure repositories/);
  assert(!fs.existsSync(f.profile.worktreeParent));
});

test('Planner broad search excludes example/runtime material; explicit inspection remains available', async t => {
  const f = templateFixture(t), token = 'needle-only-in-example-source';
  fs.writeFileSync(path.join(f.root, 'examples/python-catalog/private-search-marker.txt'), token);
  fs.writeFileSync(path.join(f.root, 'docs/project-marker.txt'), token);
  const tools = await roleTools({ role: 'planner', root: f.root, readRoots: [f.root], profile: f.profile });
  const invoke = async (name, args) => JSON.stringify(await tools.find(x => x.name === name).execute('search', args));
  const broad = await invoke('cc_grep', { pattern: token });
  assert.match(broad, /docs\/project-marker.txt/); assert(!broad.includes('private-search-marker'));
  assert.match(await invoke('cc_grep', { path: 'examples/python-catalog', pattern: token }), /private-search-marker.txt/);
  assert(!JSON.parse(await invoke('cc_find', { pattern: 'catalog.py' })).content[0].text);
});

test('an incomplete example directory is preserved and never silently recreated', async t => {
  const f = templateFixture(t), base = path.join(f.root, '.local/examples/python-catalog');
  fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, 'keep.txt'), 'local work');
  await assert.rejects(() => initExample(f.root), /Incomplete example/);
  assert.equal(fs.readFileSync(path.join(base, 'keep.txt'), 'utf8'), 'local work');
});
