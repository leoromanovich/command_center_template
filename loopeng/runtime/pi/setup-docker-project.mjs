import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/pi.mjs';
import { git } from '../core/lib/process.mjs';
import { writeJSON } from '../core/demo/fixture.mjs';

// Only explicit example setup uses these assets. Existing folders are preserved.
export async function setupDockerProject(destination = path.join(ROOT, '.docker-project')) {
  fs.mkdirSync(destination);
  const base = fs.realpathSync(destination), cc = path.join(base, 'CommandCenter'), source = path.join(base, 'repositories/catalog');
  const template = path.resolve(ROOT, '../../examples/python-catalog');
  fs.mkdirSync(path.join(cc, '.pi/cc-plans'), { recursive: true });
  fs.mkdirSync(path.dirname(source));
  fs.cpSync(path.join(template, 'repository'), source, { recursive: true });
  fs.writeFileSync(path.join(source, '.gitignore'), '__pycache__/\n.ruff_cache/\nbuild/\n');
  const seedGit = (...args) => git(source, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args);
  await seedGit('init', '-b', 'main');
  await seedGit('config', 'user.name', 'Command Center Example');
  await seedGit('config', 'user.email', 'example@invalid.test');
  await seedGit('add', '--', '.');
  await seedGit('commit', '-m', 'Create small CSV catalog example');
  for (const name of ['AGENTS.md', 'docs', 'checks']) fs.cpSync(path.join(template, name), path.join(cc, name), { recursive: true });
  fs.mkdirSync(path.join(cc, 'rules'));
  fs.copyFileSync(path.resolve(ROOT, '../../rules/review.md'), path.join(cc, 'rules/review.md'));
  fs.copyFileSync(path.resolve(ROOT, '../../model-prices.json'), path.join(cc, 'model-prices.json'));
  fs.writeFileSync(path.join(cc, '.gitignore'), '/WorkTree/\n/.pi/\n');
  const profile = path.join(cc, '.pi/cc-profile.json');
  const config = JSON.parse(fs.readFileSync(path.join(template, 'profile.json'), 'utf8'));
  config.agentRuntime = { kind: 'pi', command: [process.execPath, path.join(ROOT, 'worker.mjs')] };
  writeJSON(profile, config);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(cc, 'start'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(ROOT, 'start.mjs'))} --profile ${quote(profile)} "$@"\n`, { mode: 0o755 });
  return { base, commandCenter: cc, profile, source };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await setupDockerProject(process.argv[2]); console.log(`cd ${result.commandCenter}\n./start`);
}
