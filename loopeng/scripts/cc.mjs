import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { loadProfile } from '../runtime/core/lib/controller.mjs';
import { loadPi } from '../runtime/pi/lib/pi.mjs';
import { createUsageReader, summarizeUsage, usageDocument } from '../runtime/pi/lib/usage.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Repository sets are complete declarations; retaining an old entry adds scope.
export function mergeConfig(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Invalid config key: ${key}`);
    result[key] = key !== 'repositories' && object(value) && object(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return result;
}

export function readConfig(root = ROOT) {
  const local = path.join(root, 'cc.local.json');
  const config = mergeConfig(readJSON(path.join(root, 'cc.config.json')), fs.existsSync(local) ? readJSON(local) : {});
  if (!object(config.repositories)) throw new Error('repositories must be an object; use {} for a new empty CC.');
  if (config.pi?.plannerSearchExclude !== undefined && (!Array.isArray(config.pi.plannerSearchExclude) || !config.pi.plannerSearchExclude.every(x => typeof x === 'string' && x))) {
    throw new Error('pi.plannerSearchExclude must be an array of relative paths.');
  }
  if (config.sandbox?.kind !== 'docker' || config.devRun?.enabled !== false) {
    throw new Error('This template requires sandbox.kind=docker and devRun.enabled=false.');
  }
  if (config.pi?.demo) throw new Error('The root launcher is for real tasks. Use ./cc demo for the scripted example.');
  return config;
}

export function materializeProfile(root = ROOT) {
  root = fs.realpathSync(root);
  const config = readConfig(root);
  const profile = {
    ...config, commandCenter: root,
    agentRuntime: { kind: 'pi', command: [process.execPath, path.join(root, 'runtime/pi/worker.mjs')] },
  };
  const directory = path.join(root, '.pi');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'cc-profile.json'), text = JSON.stringify(profile, null, 2) + '\n';
  if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== text) {
    const temp = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, filename);
  }
  const resolved = loadProfile(filename);
  fs.mkdirSync(resolved.draftsRoot, { recursive: true, mode: 0o700 });
  return resolved;
}

function command(argv, { cwd = ROOT, inherit = false } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${argv[0]} exited ${result.status}: ${result.stderr ?? ''}`);
  return result.stdout?.trim();
}

export async function initExample(root = ROOT) {
  root = fs.realpathSync(root);
  const base = path.join(root, '.local/examples/python-catalog'), cc = path.join(base, 'CommandCenter');
  const filename = path.join(cc, '.pi/cc-profile.json');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const { setupDockerProject } = await import(pathToFileURL(path.join(root, 'runtime/pi/setup-docker-project.mjs')).href);
    await setupDockerProject(base);
  }
  if (!fs.existsSync(filename)) throw new Error(`Incomplete example at ${base}; inspect it before retrying. Existing files were preserved.`);
  const profile = loadProfile(filename);
  if (profile.commandCenter !== cc || [profile.stateRoot, profile.draftsRoot, profile.worktreeParent].some(p => !p.startsWith(cc + path.sep))) {
    throw new Error('Example profile must keep its Command Center, state, plans and worktrees separate from the working CC.');
  }
  return profile;
}

export function assertSources(profile) {
  for (const [id, repo] of Object.entries(profile.repositories)) {
    const source = path.resolve(profile.commandCenter, repo.source);
    if (!fs.existsSync(source)) {
      if (profile.workspace?.cloneMissing === true && repo.cloneUrl) continue;
      throw new Error(`${id}: source missing: ${source}. Configure its source path in cc.config.json or cc.local.json.`);
    }
    if (command(['git', 'rev-parse', '--show-toplevel'], { cwd: source }) !== fs.realpathSync(source)) throw new Error(`${id}: source must be a repository root`);
    command(['git', 'rev-parse', '--verify', `${repo.baseRef ?? 'HEAD'}^{commit}`], { cwd: source });
  }
}

async function launch(profile, args, root = ROOT) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'runtime/pi/start.mjs'), ...args], {
      cwd: root, stdio: 'inherit', env: { ...process.env, CC_PI_PROFILE: profile?.filename ?? '' },
    });
    const ignore = () => {}; process.on('SIGINT', ignore);
    child.once('error', reject);
    child.once('close', code => { process.removeListener('SIGINT', ignore); process.exitCode = code ?? 1; resolve(); });
  });
}

const HELP = `Command Center · Pi + Docker
  ./start                        New Planner chat, existing tasks remain in /tasks
  ./start --resume                Select a saved chat
  ./start --session <id>          Open a saved chat
  ./cc init-example              Create/preserve a separate CSV Command Center
  ./cc example [--resume]        Open that CSV Command Center with GLM
  ./cc build-image               Build docker/Dockerfile using the configured image tag
  ./cc build-image --example     Build the separate Python/Ruff demo image
  ./cc doctor                    Check Node, Pi, Git repositories and Docker image
  ./cc profile                   Materialize .pi/cc-profile.json from tracked/local config
  ./cc stats [task-id] [--json]   Token usage and manually configured model costs
  ./cc demo [--resume]            Separate scripted Docker demo, no model calls
Configuration: cc.config.json + optional ignored cc.local.json.
Runtime dependencies: Node >=22.19, Pi 0.79.9/0.85.1, Git, local Docker daemon.
No npm install is required for the pipeline.`;

const SETUP = `Рабочий Command Center пока пуст: репозитории не подключены.
1. Укажите свои repositories и команды checks в cc.config.json / cc.local.json.
   Форма: examples/cc.local.example.json; описание: docs/CONFIGURATION.md.
2. Заполните docs/repositories.md и настройте docker/Dockerfile под проект.
3. Выполните ./cc build-image, ./cc doctor, затем ./start.
CSV-пример с отдельной историей: ./cc build-image --example, затем ./cc example.
Сценарная демонстрация без вызовов модели: ./cc demo.
Сохранённая история: ./start --resume; статистика: ./cc stats.`;

export async function main(args) {
  const [action = 'help', ...rest] = args;
  if (['help', '--help', '-h'].includes(action) || (action === 'start' && rest.includes('--help'))) { console.log(HELP); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node >=22.19 is required.');
  if (!['start', 'demo', 'example', 'stats', 'build-image'].includes(action) && rest.length) throw new Error(`Unexpected arguments for ${action}`);
  if (action === 'init-example') { const p = await initExample(); console.log(`CSV Command Center: ${p.commandCenter}\nОткрыть: ./cc example`); return; }
  if (action === 'build-image') {
    if (rest.length && (rest.length !== 1 || rest[0] !== '--example')) throw new Error('Usage: ./cc build-image [--example]');
    const example = rest[0] === '--example', directory = path.join(ROOT, example ? 'examples/python-catalog/docker' : 'docker');
    const { sandbox } = example ? readJSON(path.join(ROOT, 'examples/python-catalog/profile.json')) : readConfig();
    command(['docker', 'build', '-t', sandbox.image, '-f', path.join(directory, 'Dockerfile'), directory], { inherit: true }); return;
  }
  if (action === 'example') {
    const { parseStartArgs } = await import('../runtime/pi/start.mjs');
    const parsed = parseStartArgs(rest);
    if (parsed.profile || parsed.demo || parsed['docker-demo'] || parsed.help) throw new Error('Usage: ./cc example [--resume | --session <id>]');
    const profile = await initExample();
    assertSources(profile);
    console.log(`CSV Command Center: ${profile.commandCenter}`);
    await launch(profile, ['--profile', profile.filename, ...rest]); return;
  }
  if (action === 'demo') {
    if (rest.some(x => x !== '--resume')) throw new Error('Usage: ./cc demo [--resume]');
    await launch(null, ['--docker-demo', ...rest]); return;
  }
  if (!['start', 'doctor', 'profile', 'stats'].includes(action)) throw new Error(`Unknown command: ${action}. See ./cc help.`);
  // Use the existing parser to reject a mismatched profile/demo or accidental extra arguments.
  if (action === 'start') {
    const { parseStartArgs } = await import('../runtime/pi/start.mjs');
    const parsed = parseStartArgs(rest);
    if (parsed.profile || parsed.demo || parsed['docker-demo']) throw new Error('Use root cc.config.json / cc.local.json; ./cc demo runs the separate example.');
    if (!Object.keys(readConfig().repositories ?? {}).length && !parsed.resume && !parsed.session) { console.log(SETUP); return; }
  }
  const profile = materializeProfile();
  if (action === 'profile') { console.log(profile.filename); return; }
  if (action === 'stats') {
    const ids = rest.filter(x => x !== '--json');
    if (ids.length > 1 || ids.some(x => x.startsWith('--')) || rest.filter(x => x === '--json').length > 1) throw new Error('Usage: ./cc stats [task-id] [--json]');
    const snapshot = createUsageReader(profile)(), id = ids[0];
    if (id && !snapshot.taskIDs.includes(id)) throw new Error(`Unknown CC task: ${id}`);
    console.log(rest.includes('--json') ? JSON.stringify({ version: 1, at: snapshot.at, currency: snapshot.prices.currency,
      scope: id ?? 'cc', pricing: snapshot.prices.models, summary: summarizeUsage(snapshot.records, snapshot.prices, id), warnings: snapshot.warnings }, null, 2) : usageDocument(snapshot, id));
    return;
  }
  assertSources(profile);
  if (action === 'doctor') {
    if (!Object.keys(profile.repositories).length) throw new Error(SETUP);
    const pi = await loadPi();
    console.log(`Node ${process.versions.node}; Pi ${pi.version}; ${command(['git', '--version'])}`);
    console.log(`Docker ${command(['docker', 'version', '--format', '{{.Server.Version}}'])}; image ${command(['docker', 'image', 'inspect', '--format', '{{.Id}}', profile.sandbox.image])}`);
    console.log(`Model: ${profile.pi.model}; repositories: ${Object.keys(profile.repositories).join(', ')}`);
    console.log('Local checks passed. Model authorization and network access are checked on the first model request.');
    return;
  }
  await launch(profile, ['--profile', profile.filename, ...rest]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
