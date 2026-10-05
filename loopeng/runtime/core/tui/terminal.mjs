import { spawn } from 'node:child_process';

// Same terminal takeover mechanism as OpenCode's external editor. No PTY package,
// detached process, stdin capture, shell rc sourcing or environment logging.
export async function runInTerminal(renderer, command, { onSpawn, onExit }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Для запуска нужен интерактивный терминал OpenCode.');
  if (!renderer?.suspend || !renderer?.resume) throw new Error('Эта версия OpenCode не поддерживает передачу терминала.');
  renderer.suspend();
  // The foreground child receives terminal SIGINT itself. Keep OpenCode alive.
  const interrupt = () => {};
  process.on('SIGINT', interrupt);
  try {
    renderer.currentRenderBuffer?.clear();
    process.stdout.write(`\nCommand Center · выполнение пользователем\nКаталог: ${command.resolvedCwd}\n$ ${command.command}\n\n`);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(command.shell, ['-c', command.command], {
          cwd: command.resolvedCwd, env: { ...process.env, PWD: command.resolvedCwd }, stdio: 'inherit',
        });
        let trackingError;
        child.once('spawn', () => {
          try { onSpawn(child.pid); }
          catch (error) { trackingError = error; child.kill('SIGTERM'); }
        });
        child.once('error', reject);
        child.once('close', (code, signal) => trackingError ? reject(trackingError) : resolve({ code, signal }));
      });
      onExit(result);
      process.stdout.write(`\nЗавершено: ${result.signal ? `сигнал ${result.signal}` : `код ${result.code}`}\n`);
    } catch (error) {
      onExit({ code: null, error: error.message });
      process.stdout.write(`\nОшибка запуска: ${error.message}\n`);
      throw error;
    }
    return result;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.stdin.pause();
    renderer.currentRenderBuffer?.clear();
    renderer.resume();
    renderer.requestRender?.();
  }
}
