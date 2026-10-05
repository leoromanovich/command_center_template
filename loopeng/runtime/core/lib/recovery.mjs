import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function identity(pid = process.pid) {
  const info = spawnSync('ps', ['-o', 'lstart=', '-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return { pid, host: os.hostname(), stamp: info.status === 0 ? info.stdout.trim() : undefined };
}

export function alive(owner) {
  if (!owner || !Number.isInteger(owner.pid)) return false;
  if (owner.host && owner.host !== os.hostname()) throw new Error('Process belongs to another host; inspect it before recovery');
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; return true; }
  const current = identity(owner.pid);
  if (current.stamp && /\sZ\S*$/.test(current.stamp)) return false;
  // ps includes state after the start timestamp; ignore state changes (S/R/etc).
  const start = stamp => stamp?.replace(/\s\S+$/, '');
  return !(owner.stamp && current.stamp && start(owner.stamp) !== start(current.stamp));
}

export function processTracker(dir, detail) {
  const file = path.join(dir, 'processes', `${crypto.randomUUID()}.json`);
  let record;
  return {
    onSpawn(pid) { record = { ...identity(pid), ...detail, status: 'running', started: new Date().toISOString() }; atomicJSON(file, record); },
    onClose(result) { if (record) atomicJSON(file, { ...record, status: 'finished', ended: new Date().toISOString(), result }); },
  };
}

export function activeProcesses(dir) {
  const root = path.join(dir, 'processes');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(root, name))))
    .filter(record => record.status === 'running' && alive(record));
}

export function assertNoWorkers(dir) {
  const workers = activeProcesses(dir);
  if (workers.length) throw new Error(`Previous process is still running: ${workers.map(x => `${x.actor ?? x.kind} PID ${x.pid}`).join(', ')}. Wait for it before resuming.`);
}

// Serialize stale-lock recovery as well as normal acquisition. An incomplete
// ownership record is left for inspection rather than guessed to be abandoned.
export function acquireLease(lock) {
  const readOwner = () => {
    try { return JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))); }
    catch { throw new Error(`Incomplete lock: inspect ${lock} before removing it.`); }
  };
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = readOwner();
    if (alive(owner)) throw new Error(`Run is busy (PID ${owner.pid})`);
    const gate = `${lock}.recovering`;
    try { fs.mkdirSync(gate); } catch { throw new Error(`Lock recovery in progress: ${gate}`); }
    try {
      owner = readOwner();
      if (alive(owner)) throw new Error(`Run is busy (PID ${owner.pid})`);
      fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
    } finally { fs.rmdirSync(gate); }
  }
  const token = crypto.randomUUID();
  atomicJSON(path.join(lock, 'owner.json'), { ...identity(), token, started: new Date().toISOString() });
  return () => {
    if (fs.existsSync(lock) && readOwner().token === token) fs.rmSync(lock, { recursive: true });
  };
}

export class Interrupted extends Error {
  constructor(message, transient = false) { super(message); this.name = 'Interrupted'; this.transient = transient; }
}

export function transientFailure(text) {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|network error|connection (?:closed|reset|lost)|socket hang up|rate.?limit|"statusCode"\s*:\s*(?:429|5\d\d)|"status"\s*:\s*(?:429|5\d\d)/i.test(text);
}

export function recoverySettings(value = {}) {
  const result = { maxAttempts: 3, initialDelayMs: 2000, maxDelayMs: 30000, ...value };
  for (const [key, max] of Object.entries({ maxAttempts: 10, initialDelayMs: 60000, maxDelayMs: 300000 })) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > max) throw new Error(`recovery.${key} must be 1..${max}`);
  }
  return result;
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Interrupted('Interrupted by user'));
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Interrupted('Interrupted by user')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
