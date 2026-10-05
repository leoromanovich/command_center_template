import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function eventWriter(stateDir, detail) {
  const directory = path.join(stateDir, 'pi-events');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = crypto.randomUUID(), file = path.join(directory, `${Date.now()}-${run}.jsonl`);
  let sequence = 0;
  const emit = event => fs.appendFileSync(file, JSON.stringify({ ...detail, run, sequence: ++sequence, at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  emit({ type: 'started' });
  return { file, run, emit };
}
export function tail(file, bytes = 128 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      return start ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
export function jsonLines(file, bytes) {
  return tail(file, bytes).split('\n').flatMap(line => { try { const x = JSON.parse(line); return x && typeof x === 'object' ? [x] : []; } catch { return []; } });
}
export function streams(stateDir) {
  const files = [path.join(stateDir, 'pi-events'), path.join(stateDir, 'knowledge-update/pi-events')]
    .flatMap(dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => /^\d+-[\w-]+\.jsonl$/.test(x)).map(name => path.join(dir, name)) : []);
  return files.sort((a, b) => path.basename(b).localeCompare(path.basename(a))).slice(0, 100).map(file => {
    const events = jsonLines(file);
    return { file, role: events[0]?.role, stage: events[0]?.stage, parent: events[0]?.parent, events, last: events.at(-1) };
  });
}
