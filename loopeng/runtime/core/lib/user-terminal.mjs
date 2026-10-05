import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProfile, status } from './controller.mjs';
import { pendingUserAction } from './user-actions.mjs';
import { canonical } from './policy.mjs';
import { acquireLease, assertNoWorkers, atomicJSON, processTracker } from './recovery.mjs';
import { commandAudit } from './audit.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = (ok, message) => { if (!ok) throw new Error(message); };

function context(profilePath, id, requestID) {
  const profile = loadProfile(profilePath), state = status(profilePath, id);
  const dir = path.join(profile.stateRoot, state.id);
  const packet = pendingUserAction(dir, state);
  required(packet?.id === requestID, 'Запрос уже изменён или закрыт; открой его снова.');
  required(state.status === 'waiting_for_user_action', 'Задача должна ожидать ответа пользователя.');
  required(state.approved?.digest === state.digest && hash(state.snapshot) === state.digest, 'Approved snapshot changed');
  const root = path.join(dir, 'user-actions', packet.id);
  required(canonical(root) === root, 'Symlinked user action directories are unsupported');
  const file = path.join(root, 'terminal-runs.json');
  const runs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  required(Array.isArray(runs), 'Invalid terminal run history');
  return { profile, state, packet, dir, file, runs };
}

export function userCommandRuns(profilePath, id, requestID) {
  return context(profilePath, id, requestID).runs;
}

export function completedUserCommands(packet, runs) {
  return packet.request.commands.map((command, index) => {
    const last = runs.findLast(run => run.index === index);
    if (last?.status !== 'finished' || last.exit_code !== 0 || last.command !== command.command
      || last.requested_cwd !== command.cwd) return false;
    try { return last.cwd === fs.realpathSync(command.cwd); } catch { return false; }
  });
}

// The token covers the entire request, resolved cwd and previous attempts.
// Reusing a confirmation after an attempt (including an unknown outcome) fails.
export function previewUserCommand(profilePath, id, requestID, index) {
  const { packet, runs } = context(profilePath, id, requestID);
  required(Number.isInteger(index) && index >= 0 && index < packet.request.commands.length, 'Invalid command index');
  const command = packet.request.commands[index];
  const cwd = fs.realpathSync(command.cwd);
  required(fs.statSync(cwd).isDirectory(), 'Рабочий каталог команды отсутствует.');
  return { requestID, index, command: command.command, cwd: command.cwd, resolvedCwd: cwd,
    shell: '/bin/sh', previous: runs.filter(run => run.index === index), token: hash({ packet, index, cwd, runs }) };
}

// Human TUI callback only: deliberately absent from the tool and CLI registries.
// execute hands the real terminal to the child. The request stays pending.
export async function runUserCommand(profilePath, id, preview, execute) {
  required(typeof execute === 'function', 'A human terminal executor is required');
  const initial = context(profilePath, id, preview.requestID);
  const release = acquireLease(path.join(initial.dir, '.lock'));
  try {
    const current = previewUserCommand(profilePath, id, preview.requestID, preview.index);
    required(preview.token === current.token, 'Команда, каталог или история запусков изменились; подтверди актуальные данные.');
    const { profile, state, packet, dir, file, runs } = context(profilePath, id, preview.requestID);
    assertNoWorkers(dir);
    const record = { id: crypto.randomUUID(), request_id: packet.id, index: current.index,
      command: current.command, cwd: current.resolvedCwd, requested_cwd: current.cwd, shell: current.shell,
      started: new Date().toISOString(), status: 'running' };
    const audit = { root: profile.stateRoot, stateDir: dir, feature: id, round: state.round, actor: 'user' };
    const auditRecord = { ...record, kind: 'user_command' };
    const tracker = processTracker(dir, { actor: 'user', kind: 'user_command', request_id: packet.id, command_id: record.id });
    // Persist intent before spawning: a crash here has an unknown outcome.
    runs.push(record); atomicJSON(file, runs);
    commandAudit(audit, { ...auditRecord, phase: 'started' });
    const started = Date.now();
    let result, completed = false;
    const finish = result => {
      if (completed) return;
      Object.assign(record, { status: result.error ? 'error' : result.signal ? 'cancelled' : 'finished',
        exit_code: result.code ?? null, signal: result.signal ?? null, error: result.error,
        ended: new Date().toISOString(), duration_ms: Date.now() - started });
      atomicJSON(file, runs);
      tracker.onClose({ code: record.exit_code, signal: record.signal, error: record.error });
      commandAudit(audit, { ...auditRecord, ...record, phase: 'finished' });
      completed = true;
    };
    try {
      // Save the result before restoring the TUI and continuing Builder.
      result = await execute(current, { onSpawn: pid => tracker.onSpawn(pid), onExit: finish });
      required(result && (Number.isInteger(result.code) || result.signal), 'Missing terminal process outcome');
    } catch (error) {
      result = { code: null, error: error.message };
    }
    finish(result);
    return record;
  } finally { release(); }
}
