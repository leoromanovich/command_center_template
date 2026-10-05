import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, inside } from './policy.mjs';
import { execute } from './process.mjs';
import { assertNoPendingUserAction } from './user-actions.mjs';
import { auditContext, commandAudit } from './audit.mjs';
import { identity, alive, activeProcesses, processTracker } from './recovery.mjs';

const required = (ok, message) => { if (!ok) throw new Error(message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');

export function devRunSettings(value) {
  if (value === undefined) return { enabled: false };
  required(value && typeof value === 'object' && typeof value.enabled === 'boolean', 'devRun.enabled must be boolean');
  const settings = { timeoutSeconds: 60, reviewTimeoutSeconds: 180, maxCallsPerRound: 12, maxOutputBytes: 65536, ...value };
  for (const [key, max] of Object.entries({ timeoutSeconds: 3600, reviewTimeoutSeconds: 900, maxCallsPerRound: 100, maxOutputBytes: 1048576 })) {
    required(Number.isInteger(settings[key]) && settings[key] >= 1 && settings[key] <= max, `devRun.${key} must be 1..${max}`);
  }
  return settings;
}

export function resolveDevCommands(value = {}, expand) {
  required(value && typeof value === 'object' && !Array.isArray(value), 'devCommands must be an object');
  return Object.fromEntries(Object.entries(value).map(([name, command]) => {
    required(id(name) && command && ['script', 'test', 'build'].includes(command.kind), 'Invalid devCommands name/kind');
    required(text(command.description), `devCommands.${name}.description is required`);
    const argv = expand(command.argv);
    required(argv.every(text), `devCommands.${name}.argv must contain non-empty strings`);
    if (command.kind === 'script') required(Array.isArray(command.extensions) && command.extensions.length > 0 && command.extensions.every(x => /^\.[a-z0-9]+$/.test(x)), 'Script command extensions are required');
    return [name, { kind: command.kind, description: command.description, argv, ...(command.kind === 'script' ? { extensions: command.extensions } : {}) }];
  }));
}

export function parseExecutionReview(value, requestId) {
  if (typeof value === 'string') value = JSON.parse(value);
  const keys = ['request_id', 'verdict', 'task_relevant', 'risk', 'reason', 'evidence'];
  required(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), 'Invalid execution review fields');
  required(value.request_id === requestId, 'Execution review belongs to another request');
  required(['allow', 'deny'].includes(value.verdict) && typeof value.task_relevant === 'boolean', 'Invalid execution verdict/relevance');
  required(['low', 'medium', 'high', 'unknown'].includes(value.risk), 'Invalid execution risk');
  required(text(value.reason) && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(text), 'Execution review requires reason and evidence');
  required(value.verdict !== 'allow' || (value.task_relevant && value.risk === 'low'), 'Allow requires task relevance and low risk; uncertainty must be denied');
  return value;
}

function activeState(stateDir, featureRoot, round) {
  required(canonical(stateDir) === path.resolve(stateDir), 'Symlinked run state is unsupported');
  const state = readJSON(path.join(stateDir, 'state.json'));
  required(state.status === 'building' && state.round === round, 'dev_run requires the active Builder round');
  required(state.approved?.digest === state.digest && hash(JSON.stringify(state.snapshot)) === state.digest, 'Prepared snapshot or approval changed');
  required(state.snapshot.featureRoot === canonical(featureRoot), 'Worker feature root differs from approved plan');
  return state;
}

function fileEvidence(file, requiredFile) {
  const info = fs.statSync(file);
  if (info.isDirectory() && !requiredFile) return undefined;
  required(info.isFile(), 'Target must be a regular file');
  required(info.size <= 128 * 1024, 'Target exceeds 128 KiB; use a smaller diagnostic script or test target');
  const bytes = fs.readFileSync(file);
  required(!bytes.includes(0), 'Diagnostic target must be a text file');
  return { path: file, sha256: hash(bytes), text: bytes.toString('utf8') };
}

function requestFor(input, state, settings, requestId) {
  const allowed = ['repo', 'command', 'target', 'args', 'reason', 'expected', 'timeout_seconds'];
  required(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k => allowed.includes(k)), 'Invalid dev_run arguments');
  required(id(input.repo) && id(input.command), 'repo and command must be configured names');
  required(text(input.reason) && input.reason.length <= 4000 && text(input.expected) && input.expected.length <= 4000, 'Provide reason and expected result, at most 4000 characters each');
  const repo = state.snapshot.repos.find(r => r.id === input.repo);
  required(repo, 'Repository is outside the approved task');
  required(canonical(repo.root) === repo.root && inside(state.snapshot.featureRoot, repo.root), 'Worktree path changed');
  const command = Object.hasOwn(repo.devCommands ?? {}, input.command) ? repo.devCommands[input.command] : undefined;
  required(command, 'Command is not configured in the approved profile');
  const args = input.args ?? [];
  required(Array.isArray(args) && args.length <= 32 && args.every(x => typeof x === 'string' && !x.includes('\0') && x.length <= 2048), 'Invalid command args');
  required(text(input.target) && input.target.length <= 2048 && !input.target.startsWith('-'), 'A target is required; flags are not targets');
  let target = input.target, source;
  if (command.kind === 'build') {
    required(/^[a-zA-Z0-9_][a-zA-Z0-9_./:+-]{0,199}$/.test(target), 'Invalid build target');
  } else {
    const [filename, ...selector] = command.kind === 'test' ? target.split('::') : [target];
    required(!path.isAbsolute(filename), 'Target must be relative to the selected worktree');
    const file = canonical(path.resolve(repo.root, filename));
    required(inside(repo.root, file) && !path.relative(repo.root, file).split(path.sep).includes('.git'), 'Target escapes worktree or touches .git');
    if (command.kind === 'script') required(command.extensions.includes(path.extname(file)), 'Script extension is not configured');
    source = fileEvidence(file, command.kind === 'script');
    target = [file, ...selector].join('::');
  }
  const timeout = input.timeout_seconds ?? settings.timeoutSeconds;
  required(Number.isInteger(timeout) && timeout > 0 && timeout <= settings.timeoutSeconds, 'Timeout exceeds the approved devRun limit');
  return { request_id: requestId, repo: repo.id, command: input.command, kind: command.kind, description: command.description,
    cwd: repo.root, argv: [...command.argv, target, ...args], reason: input.reason, expected: input.expected,
    timeout_seconds: timeout, ...(source ? { source } : {}) };
}

// Trusted local execution. This guard authorizes requests; it does not sandbox child code.
export async function runDevCommand(input, { stateDir, featureRoot, round, signal, review }) {
  let logDir, release, request, audit;
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const event = (type, detail = {}) => fs.appendFileSync(path.join(stateDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, round, request_id: requestId, ...detail }) + '\n');
  const finish = result => {
    const complete = { request_id: requestId, ...result, total_duration_ms: Date.now() - started, ...(logDir ? { trace: logDir } : {}) };
    if (logDir) { writeJSON(path.join(logDir, 'result.json'), complete); event('dev_run_finished', { status: result.status, trace: logDir }); }
    commandAudit(audit, { id: requestId, phase: 'decision', kind: 'dev_run_request', status: result.status, reason: result.reason, trace: logDir });
    return complete;
  };
  try {
    required(!signal?.aborted, 'Request cancelled');
    const state = activeState(stateDir, featureRoot, round);
    audit = auditContext(state, { actor: 'builder', kind: 'dev_run', request_id: requestId });
    assertNoPendingUserAction(stateDir);
    const settings = devRunSettings(state.snapshot.profile.devRun);
    required(settings.enabled, 'dev_run is disabled in the approved profile; prepare and approve an updated profile');
    const logs = path.join(stateDir, 'dev-run');
    required(canonical(logs) === logs, 'Symlinked dev-run log directory is unsupported');
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    const lock = path.join(logs, '.lock');
    try { fs.mkdirSync(lock); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerFile = path.join(lock, 'owner.json');
      required(fs.existsSync(ownerFile), 'Another dev_run is active; inspect a stale lock before removing it');
      required(!alive(readJSON(ownerFile)) && !activeProcesses(stateDir).some(x => ['dev_run', 'execution-reviewer'].includes(x.kind)), 'Another dev_run is active');
      fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
    }
    writeJSON(path.join(lock, 'owner.json'), identity());
    release = () => fs.rmSync(lock, { recursive: true, force: true });
    const prefix = `round-${round}-${state.digest.slice(0, 12)}-`;
    required(fs.readdirSync(logs).filter(name => name.startsWith(prefix)).length < settings.maxCallsPerRound, 'dev_run call limit reached for this Builder round');
    logDir = path.join(logs, `${prefix}${requestId}`);
    fs.mkdirSync(logDir, { mode: 0o700 });
    writeJSON(path.join(logDir, 'input.json'), input);
    event('dev_run_requested', { trace: logDir });
    request = requestFor(input, state, settings, requestId);
    writeJSON(path.join(logDir, 'request.json'), request);
    commandAudit(audit, { id: requestId, phase: 'requested', kind: 'dev_run_request', argv: request.argv, cwd: request.cwd,
      reason: request.reason, source_sha256: request.source?.sha256, source_record: path.join(logDir, 'request.json') });
    required(typeof review === 'function', 'Execution reviewer is unavailable');
    const verdict = parseExecutionReview(await review(state, request, logDir, { signal }), requestId);
    writeJSON(path.join(logDir, 'review.json'), verdict);
    event('dev_run_reviewed', { verdict: verdict.verdict, risk: verdict.risk });
    if (verdict.verdict === 'deny') return finish({ status: 'blocked', reason: verdict.reason, review: verdict });
    const current = activeState(stateDir, featureRoot, round);
    assertNoPendingUserAction(stateDir);
    required(current.digest === state.digest, 'Approved task changed during execution review');
    const rechecked = requestFor(input, current, settings, requestId);
    required(JSON.stringify(rechecked) === JSON.stringify(request), 'Target or command changed during execution review; submit a fresh request');
    required(!signal?.aborted, 'Request cancelled');
    event('dev_run_started', { repo: request.repo, command: request.command });
    const processStarted = Date.now();
    const result = await execute(request.argv, { cwd: request.cwd, signal, timeout: request.timeout_seconds,
      maxOutputBytes: settings.maxOutputBytes, log: path.join(logDir, 'process.log'), audit,
      ...processTracker(stateDir, { actor: 'builder', kind: 'dev_run', request_id: requestId }) });
    return finish({ status: 'completed', review: verdict, exit_code: result.code, stdout: result.out, stderr: result.err,
      duration_ms: Date.now() - processStarted, timed_out: result.timedOut, cancelled: result.cancelled, output_limited: result.limited,
      passed: result.code === 0 && !result.timedOut && !result.cancelled && !result.limited });
  } catch (error) {
    return finish({ status: 'blocked', reason: error.message });
  } finally { release?.(); }
}
