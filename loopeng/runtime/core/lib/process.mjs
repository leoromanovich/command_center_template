import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { processAudit } from './audit.mjs';

export async function execute(argv, { cwd, env = {}, timeout = 900, log, signal, input, maxOutputBytes = 16 * 1024 * 1024, audit, onSpawn, onLine, onOutput, onClose, detached = true } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('Command must be a non-empty argv array');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('maxOutputBytes must be positive');
  if (signal?.aborted) throw new Error('Operation cancelled');
  if (log) fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = log ? fs.openSync(log, 'w', 0o600) : undefined;
  const trace = processAudit(audit, argv, cwd, log);
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: { ...process.env, ...(cwd ? { PWD: cwd } : {}), GIT_OPTIONAL_LOCKS: '0', ...env },
      shell: false, detached: detached && process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let callbackError, lineBuffer = '';
    let out = '', err = '', size = 0, limited = false, timedOut = false, cancelled = false;
    const kill = () => {
      try { process.platform === 'win32' || !detached ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
    const abort = () => { cancelled = true; kill(); };
    const callback = (fn, value) => { try { fn?.(value); } catch (error) { callbackError = error; kill(); } };
    child.once('spawn', () => { trace.start(child.pid); callback(onSpawn, child.pid); });
    signal?.addEventListener('abort', abort, { once: true });
    function collect(chunk, stderr) {
      if (limited) return;
      const kept = chunk.subarray(0, Math.max(0, maxOutputBytes - size));
      if (fd !== undefined) fs.writeSync(fd, kept);
      size += kept.length;
      if (stderr) err += kept.toString(); else out += kept.toString();
      callback(() => onOutput?.(kept.toString(), stderr));
      if (!stderr && onLine) {
        lineBuffer += kept.toString();
        let newline;
        while ((newline = lineBuffer.indexOf('\n')) >= 0) {
          callback(onLine, lineBuffer.slice(0, newline)); lineBuffer = lineBuffer.slice(newline + 1);
        }
      }
      if (kept.length !== chunk.length) { limited = true; kill(); }
    }
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    // EPIPE is expected if a failed command exits before reading its prompt.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (fd !== undefined) fs.closeSync(fd);
      if (lineBuffer) callback(onLine, lineBuffer);
      trace.finish({ code, timedOut, cancelled, limited, spawnError });
      callback(onClose, { code, timedOut, cancelled, limited, spawnError: spawnError?.message });
      if (callbackError || spawnError) reject(callbackError ?? spawnError);
      else resolve({ code, out, err, timedOut, cancelled, limited });
    });
  });
}

export async function git(cwd, ...args) {
  const result = await execute(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout: 60 });
  if (result.code !== 0 || result.timedOut || result.limited) throw new Error(`Git failed in ${cwd}: ${result.err.trim()}`);
  return result.out;
}
