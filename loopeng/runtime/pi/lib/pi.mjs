import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUPPORTED_PI_VERSIONS = ['0.79.9', '0.85.1'];
const PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const manifest = root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function packageAbove(candidate) {
  let cursor;
  try { cursor = fs.realpathSync(candidate); if (!fs.statSync(cursor).isDirectory()) cursor = path.dirname(cursor); } catch { return; }
  while (true) {
    try { if (manifest(cursor).name === PACKAGE_NAME) return cursor; } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export function piPackage({ env = process.env, from = import.meta.url } = {}) {
  if (env.PI_PACKAGE_ROOT) {
    try {
      const root = fs.realpathSync(env.PI_PACKAGE_ROOT);
      if (manifest(root).name === PACKAGE_NAME) return root;
    } catch {}
    throw new Error(`PI_PACKAGE_ROOT must point to the installed ${PACKAGE_NAME} directory containing package.json: ${env.PI_PACKAGE_ROOT}`);
  }
  // Resolve the package owning the selected CLI, regardless of dist/ nesting.
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const root = packageAbove(path.join(dir, 'pi'));
    if (root) return root;
  }
  // Reading package metadata also works when exports supports ESM imports only.
  const local = createRequire(from);
  for (const dir of local.resolve.paths(PACKAGE_NAME) ?? []) {
    try {
      const root = fs.realpathSync(path.join(dir, PACKAGE_NAME));
      if (manifest(root).name === PACKAGE_NAME) return root;
    } catch {}
  }
  throw new Error(`Cannot locate ${PACKAGE_NAME}. Put pi on PATH or set PI_PACKAGE_ROOT to its package directory. Supported versions: ${SUPPORTED_PI_VERSIONS.join(', ')}.`);
}

export function piCli(root = piPackage()) {
  const pkg = manifest(root), bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (typeof bin !== 'string' || !bin) throw new Error(`Pi ${pkg.version}: package.json has no bin.pi entry (${root})`);
  const entry = path.resolve(root, bin);
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw new Error(`Pi CLI is missing: ${entry}. Reinstall the package.`);
  return entry;
}
let cached;
export async function loadPi() {
  if (!cached) cached = (async () => {
    const root = piPackage(), require = createRequire(path.join(root, 'package.json'));
    const version = manifest(root).version;
    if (!SUPPORTED_PI_VERSIONS.includes(version)) throw new Error(`Found pi ${version} at ${root}. This adapter supports ${SUPPORTED_PI_VERSIONS.join(', ')}; update the adapter for this pi version.`);
    const dependency = name => {
      const packageRoot = (require.resolve.paths(name) ?? []).map(dir => path.join(dir, name)).find(dir => fs.existsSync(path.join(dir, 'package.json')));
      if (!packageRoot) throw new Error(`Missing pi dependency: ${name}`);
      const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
      const entry = pkg.exports?.['.'] ?? pkg.exports;
      const exported = typeof entry === 'string' ? entry : entry?.import;
      const main = typeof exported === 'string' ? exported : exported?.default;
      return pathToFileURL(path.resolve(packageRoot, main ?? pkg.module ?? pkg.main)).href;
    };
    const [sdk, ai, tui, typebox] = await Promise.all([
      import(pathToFileURL(path.join(root, 'dist/index.js')).href),
      import(dependency('@earendil-works/pi-ai')),
      import(dependency('@earendil-works/pi-tui')),
      import(dependency('typebox')),
    ]);
    return { sdk, ai, tui, Type: typebox.Type, root, version };
  })();
  return cached;
}

export async function workerModels({ demo = false } = {}) {
  const { sdk, ai } = await loadPi();
  if (sdk.ModelRuntime) {
    const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false, ...(demo ? {
      credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStore: new ai.InMemoryModelsStore(), refreshOnCreate: false,
    } : {}) });
    return { sessionOptions: { modelRuntime: runtime }, find: (provider, id) => runtime.getModel(provider, id),
      register: (provider, config) => runtime.registerProvider(provider, config) };
  }
  const authStorage = demo ? sdk.AuthStorage.inMemory() : sdk.AuthStorage.create();
  const modelRegistry = demo ? sdk.ModelRegistry.inMemory(authStorage) : sdk.ModelRegistry.create(authStorage);
  return { sessionOptions: { authStorage, modelRegistry }, find: (provider, id) => modelRegistry.find(provider, id),
    register: (provider, config) => modelRegistry.registerProvider(provider, config) };
}
