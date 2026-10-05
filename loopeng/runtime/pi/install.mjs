import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/pi.mjs';
import { loadProfile } from '../core/lib/controller.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function install({ source, model = 'zai/glm-5.3-flash', name = 'start-pi' }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Use a plain launcher filename');
  if (typeof model !== 'string' || !/^[^/\s]+\/\S+$/.test(model)) throw new Error('--model must be a pi provider/model ID');
  const previous = loadProfile(source), cc = previous.commandCenter;
  const file = path.join(cc, '.pi', 'cc-profile.json'), launcher = path.join(cc, name);
  if (fs.existsSync(file) || fs.existsSync(launcher)) throw new Error('Existing pi profile/launcher preserved. Edit it directly, or choose a new Command Center.');
  const profile = { ...previous, agentRuntime: { kind: 'pi', command: [process.execPath, path.join(ROOT, 'worker.mjs')] },
    stateRoot: '.pi/cc-state', draftsRoot: '.pi/cc-plans', pi: { model,
      models: Object.fromEntries(['builder', 'reviewer', 'explorer', 'execution-reviewer'].map(role => [role, model])),
      explorerLimit: 3, foregroundExtensions: [] } };
  delete profile.filename;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(cc, profile.draftsRoot), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh\nexec node ${quote(path.join(ROOT, 'start.mjs'))} --profile ${quote(file)} "$@"\n`, { flag: 'wx', mode: 0o755 });
  const ignore = path.join(cc, '.gitignore'), current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const additions = ['/.pi/cc-state/', '/.pi/cc-plans/', '/.pi/sessions/'].filter(line => !current.split('\n').includes(line));
  if (additions.length) fs.appendFileSync(ignore, (current.endsWith('\n') || !current ? '' : '\n') + additions.join('\n') + '\n');
  return { profile: file, launcher };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), value = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
    if (!value('--profile')) throw new Error('Usage: node install.mjs --profile /path/opencode-profile.json [--model provider/model] [--name start-pi] (default model: zai/glm-5.3-flash)');
    console.log(JSON.stringify(install({ source: value('--profile'), model: value('--model'), name: value('--name') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
