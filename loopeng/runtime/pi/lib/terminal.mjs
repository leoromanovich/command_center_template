import { spawn } from 'node:child_process';

// Only a human UI callback calls this function. Password input is not recorded.
export async function terminalProcess(tui, argv, cwd, callbacks = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive terminal is required');
  const ignoreInterrupt = () => {};
  tui.stop(); process.on('SIGINT', ignoreInterrupt);
  process.stdout.write('\x1b[2J\x1b[H');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: 'inherit', shell: false });
      child.once('spawn', () => callbacks.onSpawn?.(child.pid));
      child.once('error', reject);
      child.once('close', (code, signal) => {
        const result = { code, signal };
        callbacks.onExit?.(result); resolve(result);
      });
    });
  } finally {
    process.removeListener('SIGINT', ignoreInterrupt);
    process.stdin.pause(); tui.start(); tui.requestRender(true);
  }
}
