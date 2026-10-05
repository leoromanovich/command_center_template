import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, status, summary } from './controller.mjs';
import { atomicJSON, identity, alive, acquireLease, assertNoWorkers, delay } from './recovery.mjs';
import { knowledgeStatus } from './knowledge.mjs';

export function jobStatus(profilePath, id) {
  const profile = loadProfile(profilePath);
  const state = status(profilePath, id); // validates the ID
  const file = path.join(profile.stateRoot, state.id, 'job.json');
  if (!fs.existsSync(file)) return undefined;
  const job = JSON.parse(fs.readFileSync(file));
  return { ...job, alive: ['starting', 'running'].includes(job.status) && alive(job.owner) };
}

export function listTasks(profilePath) {
  const profile = loadProfile(profilePath);
  if (!fs.existsSync(profile.stateRoot)) return [];
  return fs.readdirSync(profile.stateRoot, { withFileTypes: true }).filter(x => x.isDirectory() && fs.existsSync(path.join(profile.stateRoot, x.name, 'state.json')))
    .map(x => { try {
      const kb = knowledgeStatus(path.join(profile.stateRoot, x.name));
      return { ...summary(status(profilePath, x.name)), job: jobStatus(profilePath, x.name),
        knowledge: kb ? { status: kb.status, error: kb.error, count: kb.proposals?.length ?? 0, running: kb.job?.alive } : undefined };
    } catch (error) { return { id: x.name, status: 'invalid', error: error.message }; } });
}

export function stopRun(profilePath, id) {
  const job = jobStatus(profilePath, id);
  if (!job?.alive) throw new Error('Background runner is not active');
  process.kill(job.owner.pid, 'SIGTERM');
  return { requested: true, pid: job.owner.pid };
}

export async function startRun(profilePath, id, { action = 'run', expectedFingerprint, expectedDigest, expectedTargets, expectedToken, mode, message } = {}) {
  if (!['run', 'accept', 'commit-reviewed', 'refresh-base', 'publish-accepted', 'cleanup-accepted'].includes(action)) throw new Error('Invalid background action');
  const profile = loadProfile(profilePath), state = status(profilePath, id);
  const dir = path.join(profile.stateRoot, state.id), gate = path.join(dir, '.launch-lock');
  const release = acquireLease(gate);
  try {
    const current = jobStatus(profilePath, id);
    if (current?.alive) return current;
    assertNoWorkers(dir);
    if (['publish-accepted', 'cleanup-accepted'].includes(action) && state.status !== 'accepted') throw new Error('Accept the result first');
    if (action === 'run' && ['ready_for_user', 'accepted', 'waiting_for_user_action'].includes(state.status)) return { status: 'idle', alive: false };
    if (action === 'run' && !['approved', 'building', 'checking', 'reviewing', 'publishing', 'accepting'].includes(state.status)) throw new Error('Approve or resume this task first');
    if (action === 'accept' && state.status !== 'ready_for_user') throw new Error('Only ready_for_user may be accepted');
    if (action === 'commit-reviewed' && !['ready_for_user', 'accepted', 'committing_reviewed'].includes(state.status)) throw new Error('Only reviewed results may be committed');
    if (action === 'refresh-base' && (!['prepared', 'approved', 'refreshing_base'].includes(state.status) || state.round !== 0)) throw new Error('Base refresh requires a never-started task');
    const token = crypto.randomUUID(), log = path.join(dir, `runner-${token}.log`);
    const file = path.join(dir, 'job.json');
    const approval = { expectedFingerprint, expectedDigest, expectedTargets, expectedToken, mode, message };
    atomicJSON(file, { token, action, ...approval, status: 'starting', owner: identity(), log, created: new Date().toISOString() });
    const fd = fs.openSync(log, 'a', 0o600);
    const node = process.env.CC_NODE ?? (process.versions.bun ? 'node' : process.execPath);
    const env = { ...process.env };
    for (const key of ['CC_WORKER_ROLE', 'CC_RUN_DIR', 'CC_ROUND', 'CC_WORKER_ROOT', 'CC_WORKER_READ_ROOTS', 'NODE_TEST_CONTEXT']) delete env[key];
    const child = spawn(node, [fileURLToPath(new URL('../runner.mjs', import.meta.url)), profile.filename, id, token, action],
      { cwd: profile.commandCenter, env, stdio: ['ignore', fd, fd], detached: true });
    fs.closeSync(fd);
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); }); }
    catch (error) {
      atomicJSON(file, { token, action, status: 'failed', error: error.message, log, ended: new Date().toISOString() });
      throw error;
    }
    atomicJSON(file, { token, action, ...approval, status: 'running', owner: identity(child.pid), log, created: new Date().toISOString() });
    child.unref();
    return jobStatus(profilePath, id);
  } finally { release(); }
}

export async function waitRun(profilePath, id, { signal, milliseconds = 2000 } = {}) {
  const deadline = Date.now() + milliseconds;
  while (jobStatus(profilePath, id)?.alive && Date.now() < deadline && !signal?.aborted) await delay(200, signal);
  return { ...summary(status(profilePath, id)), job: jobStatus(profilePath, id) };
}
