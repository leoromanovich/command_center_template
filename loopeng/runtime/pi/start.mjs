import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, piCli, loadPi, SUPPORTED_PI_VERSIONS } from './lib/pi.mjs';
import { setupDemo } from './setup-demo.mjs';
import { setupDockerDemo } from './setup-docker-demo.mjs';
import { loadProfile } from '../core/lib/controller.mjs';

export function parseStartArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], key = flag.slice(2);
    if (!['--demo', '--docker-demo', '--profile', '--resume', '--session', '--help'].includes(flag)) throw new Error(`Unknown argument: ${flag}. See ./start --help.`);
    if (key in options) throw new Error(`Duplicate argument: ${flag}`);
    if (['--profile', '--session'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      options[key] = value;
    } else options[key] = true;
  }
  if ([options.demo, options['docker-demo'], options.profile].filter(Boolean).length > 1) throw new Error('Choose --demo, --docker-demo or --profile.');
  if (options.resume && options.session) throw new Error('Choose --resume (session picker) or --session <id>.');
  return options;
}

export function sessionArgs(options) {
  return options.session ? ['--session', options.session] : options.resume ? ['--resume'] : [];
}

export function resumeCommand(options, profilePath) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return [path.join(ROOT, 'start'), ...(options.demo ? ['--demo'] : options['docker-demo'] ? ['--docker-demo'] : ['--profile', profilePath]), '--resume'].map(quote).join(' ');
}

async function main() {
try {
  const options = parseStartArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: ./start --demo | ./start --docker-demo | ./start --profile /path/profile.json [--resume | --session <id>]\nPi ${SUPPORTED_PI_VERSIONS.join(' / ')} and Node >=22.19.\n--docker-demo: scripted pi + real local Docker image.\n--demo: scripted example, no model calls. Real tasks require --profile.\n--resume: choose a previous chat. --session <id>: open a specific chat.\nEnter the command and its arguments on one line, then press Enter.`);
  } else {
    let profilePath = options.profile ?? process.env.CC_PI_PROFILE;
    if (!options.demo && !options['docker-demo'] && !profilePath) throw new Error('Provide --profile /path/profile.json or --demo on the same command line. Example: ./start --demo');
    await loadPi();
    if (options.demo || options['docker-demo']) {
      const dir = path.join(ROOT, options['docker-demo'] ? '.docker-demo' : '.demo');
      if (!fs.existsSync(dir)) await (options['docker-demo'] ? setupDockerDemo : setupDemo)(dir);
      profilePath = path.join(dir, 'profile.json');
    }
    const profile = loadProfile(profilePath);
    const cli = piCli();
    const sessionDir = path.join(profile.commandCenter, '.pi', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const extensions = [path.join(ROOT, 'extension.mjs'), ...(profile.pi?.foregroundExtensions ?? [])];
    const argv = [cli, '--no-extensions', ...extensions.flatMap(x => ['-e', path.resolve(profile.commandCenter, x)]), '--session-dir', sessionDir,
      ...sessionArgs(options), ...(profile.pi?.demo ? ['--provider', 'cc-demo', '--model', 'scripted'] : profile.pi?.model ? ['--model', profile.pi.model] : []),
      ...(profile.pi?.thinkingLevel ? ['--thinking', profile.pi.thinkingLevel] : [])];
    const child = spawn(process.execPath, argv, { cwd: profile.commandCenter, stdio: 'inherit',
      env: { ...process.env, CC_PI_PROFILE: profile.filename, CC_NODE: process.execPath } });
    const ignore = () => {}; process.on('SIGINT', ignore);
    child.once('error', e => { console.error(e.message); process.exitCode = 1; });
    child.once('close', code => {
      process.removeListener('SIGINT', ignore); process.exitCode = code ?? 1;
      console.log(`\nCommand Center — вернуться к диалогу с профилем и расширениями:\n${resumeCommand(options, profile.filename)}\nЗадачи и фоновые агенты доступны через /tasks.`);
    });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
