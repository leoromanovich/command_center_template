import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { piPackage, piCli, loadPi, workerModels } from '../lib/pi.mjs';

const name = '@earendil-works/pi-coding-agent';
function fixture(t, cli = 'dist/bundle/cli.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi runtime paths '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'node_modules', name), bin = path.join(dir, 'bin');
  fs.mkdirSync(path.dirname(path.join(root, cli)), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: cli.includes('bundle') ? '0.85.1' : '0.79.9',
    type: 'module', bin: { pi: cli }, exports: { '.': { import: './dist/index.js' } } }));
  fs.writeFileSync(path.join(root, cli), '// Metadata fixture only; never imported or executed.');
  fs.symlinkSync(path.join(root, cli), path.join(bin, 'pi'));
  return { dir, root: fs.realpathSync(root), bin, from: path.join(dir, 'consumer', 'load.mjs') };
}

test('finds the package through old and bundled CLI paths and uses its declared bin', t => {
  for (const cli of ['dist/cli.js', 'dist/bundle/cli.js', 'dist/deeper/cli.js']) {
    const f = fixture(t, cli);
    const root = piPackage({ env: { PATH: f.bin }, from: f.from });
    assert.equal(root, f.root); assert.equal(piCli(root), path.join(root, cli));
  }
});

test('ESM-only local installation resolves from metadata without a pi executable on PATH', t => {
  const f = fixture(t);
  assert.equal(piPackage({ env: { PATH: '' }, from: f.from }), f.root);
});

test('explicit package override wins and invalid overrides do not fall through silently', t => {
  const first = fixture(t, 'dist/cli.js'), second = fixture(t);
  assert.equal(piPackage({ env: { PATH: first.bin, PI_PACKAGE_ROOT: second.root }, from: first.from }), second.root);
  assert.throws(() => piPackage({ env: { PATH: first.bin, PI_PACKAGE_ROOT: first.bin }, from: first.from }), /PI_PACKAGE_ROOT.*package.json/);
  fs.rmSync(piCli(second.root));
  assert.throws(() => piCli(second.root), /CLI is missing/);
});

test('installed pi runtime receives the SDK model option and registers a local provider', async () => {
  const { sdk, version } = await loadPi(), models = await workerModels({ demo: true });
  models.register('cc-runtime-test', { api: 'openai-completions', baseUrl: 'https://invalid.example', apiKey: 'unused-test-key',
    models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  assert.equal(models.find('cc-runtime-test', 'test').id, 'test');
  if (sdk.ModelRuntime) {
    assert.equal(version, '0.85.1');
    assert(models.sessionOptions.modelRuntime);
    assert(!('authStorage' in models.sessionOptions));
    assert(!('modelRegistry' in models.sessionOptions));
  } else assert(models.sessionOptions.authStorage && models.sessionOptions.modelRegistry);
});
