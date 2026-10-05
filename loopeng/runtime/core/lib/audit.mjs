import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Append-only records. Never record the environment or the stdin prompt.
export function commandAudit(context, record) {
  if (!context?.root) return;
  const entry = { version: 1, at: new Date().toISOString(), ...context, ...record };
  delete entry.root; delete entry.stateDir;
  const roots = [...new Set([context.root, context.stateDir].filter(Boolean))];
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    const command = entry.command ?? entry.argv?.map(value => JSON.stringify(value)).join(' ') ?? '';
    const lines = [`[${entry.at}] ${entry.phase} ${entry.actor ?? 'controller'} task=${entry.feature ?? '-'} id=${entry.id}`,
      `cwd: ${entry.container_cwd ?? entry.cwd ?? ''}`, command,
      ...(entry.phase === 'finished' ? [`exit=${entry.exit_code ?? '?'} duration_ms=${entry.duration_ms ?? '?'} status=${entry.status ?? ''}`] : []),
      ...(entry.log ? [`log: ${entry.log}`] : []), ''];
    fs.appendFileSync(path.join(root, 'commands.log'), lines.join('\n') + '\n', { mode: 0o600 });
  }
  return entry;
}

export function auditContext(state, extra = {}) {
  return { root: state.snapshot.profile.stateRoot, stateDir: path.join(state.snapshot.profile.stateRoot, state.id),
    feature: state.id, round: state.round, actor: 'controller', ...extra };
}

export function processAudit(context, argv, cwd, log) {
  const started = Date.now();
  const data = { id: crypto.randomUUID(), kind: context?.kind ?? 'process', argv, cwd: cwd ?? process.cwd(), log };
  return {
    start(pid) { commandAudit(context, { ...data, phase: 'started', pid }); },
    finish(result) { commandAudit(context, { ...data, phase: 'finished', exit_code: result.code ?? null,
      duration_ms: Date.now() - started, status: result.spawnError ? 'spawn_error' : result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : result.limited ? 'output_limit' : 'completed' }); },
  };
}

// A missing terminal record means an interrupted/unknown command, never success.
export function unfinishedCommands(stateDir) {
  const file = path.join(stateDir, 'commands.jsonl');
  const pending = new Map();
  if (!fs.existsSync(file)) return [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.phase === 'started' && ['bash', 'dev_run', 'hook', 'check', 'docker_exec', 'docker_tool'].includes(entry.kind)) pending.set(entry.id, entry);
    if (['finished', 'reconciled'].includes(entry.phase)) pending.delete(entry.id);
  }
  return [...pending.values()];
}
