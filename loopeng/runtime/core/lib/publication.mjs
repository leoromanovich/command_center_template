import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProfile, status, fingerprint, validateWorktrees, hook, diffReport } from './controller.mjs';
import { gitPublication, publishGit } from './git-workflow.mjs';
import { git, execute } from './process.mjs';
import { atomicJSON, acquireLease, assertNoWorkers, processTracker } from './recovery.mjs';
import { pendingUserAction } from './user-actions.mjs';
import { auditContext } from './audit.mjs';
import { canonical, inside } from './policy.mjs';
import { stopDocker } from './docker.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const now = () => new Date().toISOString();
const read = file => JSON.parse(fs.readFileSync(file));
const save = (dir, state) => { state.updated = now(); atomicJSON(path.join(dir, 'state.json'), state); };
async function withTask(profilePath, id, fn) {
  const profile = loadProfile(profilePath), state = status(profilePath, id), dir = path.join(profile.stateRoot, state.id);
  const release = acquireLease(path.join(dir, '.lock'));
  try { assertNoWorkers(dir); return await fn(profile, status(profilePath, id), dir); } finally { release(); }
}

async function acceptedEvidence(state, dir) {
  requireThat(state.status === 'accepted', 'Сначала примите результат в diff.');
  requireThat(state.workspaceCleanup?.status !== 'done', 'Worktree уже удалён.');
  requireThat(state.approved?.digest === state.digest && hash(state.snapshot) === state.digest, 'Approved snapshot changed');
  requireThat(!pendingUserAction(dir, state), 'Resolve the pending user action first');
  const evidence = read(path.join(dir, 'result.json'));
  requireThat(state.review?.verdict === 'approved' && evidence.fingerprint === state.reviewedFingerprint && evidence.id === state.id
    && hash(state.review) === hash(evidence.review), 'Successful review evidence is required');
  const expected = state.snapshot.repos.flatMap(repo => Object.entries(repo.checks).flatMap(([phase, commands]) => commands.map(argv => ({ repo: repo.id, phase, argv }))));
  expected.push(...state.snapshot.integration.map(x => ({ repo: 'integration', phase: 'integration', ...x })));
  const key = ({ repo, phase, argv, cwd }) => JSON.stringify({ repo, phase, argv, cwd });
  requireThat(Array.isArray(evidence.checks) && evidence.checks.every(x => x.passed && x.code === 0)
    && hash(evidence.checks.map(key).sort()) === hash(expected.map(key).sort()), 'Successful checks for every approved command are required');
  requireThat(await fingerprint(state.snapshot) === state.reviewedFingerprint, 'Файлы изменились после приёмки. Публикация запрещена.');
  const heads = { ...state.publishedHeads };
  // Reconcile the narrow crash window after update-ref, before state persistence.
  for (const repo of state.snapshot.repos) {
    const record = state.gitPublication?.[repo.id];
    if (record?.head && (await git(repo.root, 'rev-parse', 'HEAD')).trim() === record.head) heads[repo.id] = record.head;
  }
  await validateWorktrees(state.snapshot, heads);
}

function permissions(profile, mode) {
  requireThat(['commit', 'push', 'mr'].includes(mode), 'Unknown publication mode');
  requireThat(profile.git?.allowCommit === true, 'В профиле нужен git.allowCommit=true.');
  requireThat(mode === 'commit' || profile.git?.allowPush === true, 'В профиле нужен git.allowPush=true.');
  requireThat(mode !== 'mr' || Array.isArray(profile.hooks?.mergeRequest) && profile.hooks.mergeRequest.length && profile.hooks.mergeRequest.every(x => typeof x === 'string' && !x.includes('\0')), 'Настройте hooks.mergeRequest в профиле.');
}

async function makePlan(profile, state, { mode = 'commit', message = `Implement ${state.id}` } = {}) {
  permissions(profile, mode);
  requireThat(typeof message === 'string' && message.trim() && message.length <= 1000 && !/[\x00-\x1f\x7f]/.test(message), 'Сообщение коммита: одна непустая строка, до 1000 символов.');
  const spec = await gitPublication(profile, { publication: { commit: true, push: mode !== 'commit' } }, state.snapshot.repos);
  spec.messages = {};
  const repositories = [];
  let canEditMessage = true;
  for (const repo of state.snapshot.repos) {
    const head = (await git(repo.root, 'rev-parse', 'HEAD')).trim(), existing = state.gitPublication?.[repo.id];
    const fields = (await git(repo.root, 'diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', repo.base, '--')).split('\0').filter(Boolean);
    const files = new Map();
    for (let i = 0; i < fields.length; i += 2) files.set(fields[i + 1], fields[i]);
    for (const name of (await git(repo.root, 'ls-files', '-z', '--others', '--exclude-standard')).split('\0').filter(Boolean)) if (!files.has(name)) files.set(name, 'A');
    const committed = head !== repo.base;
    canEditMessage &&= !committed && !existing?.head;
    spec.messages[repo.id] = committed ? (await git(repo.root, 'log', '-1', '--format=%B')).trimEnd()
      : `${message.trim()}${state.snapshot.repos.length > 1 ? ` (${repo.id})` : ''}\n\nCommand-Center: ${state.digest}\nReviewed: ${state.reviewedFingerprint}`;
    repositories.push({ id: repo.id, root: repo.root, branch: repo.branch, head, committed,
      files: [...files].map(([name, change]) => ({ name, change })) });
  }
  const vars = { node: process.execPath, commandCenter: profile.commandCenter, feature: state.snapshot.featureRoot,
    bundle: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  const mrHook = mode === 'mr' ? profile.hooks.mergeRequest.map(arg => arg.replace(/\{(node|bundle|commandCenter|feature)\}/g, (_, key) => vars[key])) : undefined;
  return { digest: state.digest, fingerprint: state.reviewedFingerprint, mode, message: message.trim(), spec, repositories, mrHook, canEditMessage };
}

export async function previewPublication(profilePath, id, options = {}) {
  return withTask(profilePath, id, async (profile, state, dir) => {
    await acceptedEvidence(state, dir);
    const pending = state.delivery?.status === 'pending';
    const previous = state.delivery;
    const reuse = previous?.status === 'done' && (options.mode ?? previous.plan.mode) === previous.plan.mode && (options.message ?? previous.plan.message) === previous.plan.message;
    const preferredMode = state.snapshot.publication.mergeRequest ? 'mr' : state.snapshot.publication.git?.push ? 'push' : 'commit';
    const plan = pending || reuse ? previous.plan : await makePlan(profile, state, { mode: preferredMode, ...options, message: options.message ?? previous?.plan.message });
    permissions(profile, plan.mode);
    return { ...plan, token: hash(plan), pending, done: state.delivery?.status === 'done' && state.delivery.token === hash(plan),
      canEditMessage: plan.canEditMessage && !Object.values(state.gitPublication ?? {}).some(x => x.head),
      error: state.delivery?.error, mergeRequest: state.hookResults.mergeRequest,
      capabilities: { commit: profile.git?.allowCommit === true, push: profile.git?.allowPush === true, mr: profile.git?.allowPush === true && !!profile.hooks?.mergeRequest } };
  });
}

export async function publishAccepted(profilePath, id, { expectedToken, mode, message, signal } = {}) {
  return withTask(profilePath, id, async (profile, state, dir) => {
    await acceptedEvidence(state, dir);
    const previous = state.delivery;
    const plan = previous?.status === 'pending' || previous?.status === 'done' && previous.token === expectedToken ? previous.plan : await makePlan(profile, state, { mode, message });
    requireThat(expectedToken && hash(plan) === expectedToken, 'Публикация изменилась после просмотра. Откройте экран заново.');
    permissions(profile, plan.mode);
    const current = await gitPublication(profile, { publication: { commit: true, push: plan.mode !== 'commit' } }, state.snapshot.repos);
    requireThat(hash(current.targets) === hash(plan.spec.targets), 'Изменились ветки или адрес публикации.');
    requireThat(!Object.values(state.hookResults).some(x => x.status === 'started'), 'Исход MR/Jira неизвестен. Проверьте сервис и укажите результат в карточке публикации.');
    if (previous?.status === 'done' && previous.token === expectedToken) return state;
    state.delivery = { status: 'pending', plan, token: expectedToken, authorizedAt: previous?.authorizedAt ?? now() };
    save(dir, state);
    try {
      await publishGit(dir, state, { save, fingerprint, signal, spec: plan.spec });
      await validateWorktrees(state.snapshot, state.publishedHeads);
      const resultFile = path.join(dir, 'result.json');
      atomicJSON(resultFile, { ...read(resultFile), git: state.gitPublication, publishedHeads: state.publishedHeads });
      await hook(dir, state, 'mergeRequest', signal, { enabled: plan.mode === 'mr', argv: plan.mrHook });
      await validateWorktrees(state.snapshot, state.publishedHeads);
      requireThat(await fingerprint(state.snapshot) === state.reviewedFingerprint, 'Publication hook changed reviewed files');
      state.delivery.status = 'done'; state.delivery.completedAt = now(); delete state.error;
      atomicJSON(resultFile, { ...read(resultFile), hooks: state.hookResults, delivery: state.delivery });
    } catch (error) { state.delivery.error = error.message; state.error = error.message; }
    save(dir, state); return state;
  });
}

// Explicit human reconciliation. A failed request is never blindly replayed.
export async function reconcilePublication(profilePath, id, { expectedToken, applied, resourceID, url } = {}) {
  return withTask(profilePath, id, async (_profile, state, dir) => {
    requireThat(state.status === 'accepted' && state.delivery?.token === expectedToken && state.hookResults.mergeRequest?.status === 'started', 'Нет соответствующей незавершённой публикации MR.');
    const pending = state.hookResults.mergeRequest;
    requireThat(typeof applied === 'boolean', 'Укажите фактический исход.');
    if (applied) {
      requireThat(typeof resourceID === 'string' && resourceID.trim() && /^https?:\/\//.test(url), 'Укажите ID и HTTP(S) URL созданного MR.');
      requireThat(!pending.previous || pending.previous.id === resourceID, 'MR ID differs from the previous resource');
      state.hookResults.mergeRequest = { status: 'done', id: resourceID, url, fingerprint: state.reviewedFingerprint, at: now() };
    } else if (pending.previous) state.hookResults.mergeRequest = pending.previous;
    else delete state.hookResults.mergeRequest;
    save(dir, state); return state;
  });
}

async function cleanupPlan(profile, state, dir) {
  requireThat(state.status === 'accepted' && (!state.delivery || state.delivery.status === 'done'), 'Сначала завершите публикацию.');
  requireThat(!Object.values(state.hookResults).some(x => x.status === 'started'), 'Сначала выясните исход внешнего действия.');
  const recovering = state.workspaceCleanup?.status === 'pending', repositories = [];
  requireThat(hash(state.snapshot) === state.digest && state.approved?.digest === state.digest, 'Approved snapshot changed');
  if (!recovering) await acceptedEvidence(state, dir);
  for (const repo of state.snapshot.repos) {
    const saved = state.workspaceCleanup?.plan.repositories.find(x => x.id === repo.id);
    const root = repo.root;
    requireThat(root !== state.snapshot.featureRoot && inside(state.snapshot.featureRoot, root) && canonical(root) === root, 'Worktree path changed');
    const mergeRef = recovering ? saved.mergeRef : profile.repositories[repo.id].git?.mergeTarget ?? profile.repositories[repo.id].baseRef;
    requireThat(typeof mergeRef === 'string' && mergeRef && !mergeRef.startsWith('-'), `${repo.id}: настройте git.mergeTarget или baseRef.`);
    const target = (await git(repo.source, 'rev-parse', '--verify', '--end-of-options', `${mergeRef}^{commit}`)).trim();
    const head = fs.existsSync(root) ? (await git(root, 'rev-parse', 'HEAD')).trim() : recovering ? saved.head : undefined;
    requireThat(head && head === (state.publishedHeads?.[repo.id] ?? repo.base), `${repo.id}: HEAD changed`);
    if (fs.existsSync(root)) {
      requireThat((await git(root, 'branch', '--show-current')).trim() === repo.branch, 'Worktree branch changed');
      requireThat(canonical(path.resolve(root, (await git(root, 'rev-parse', '--git-common-dir')).trim())) === repo.common, 'Git identity changed');
      requireThat(!(await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored')).length, `${repo.id}: есть изменённые, новые или ignored-файлы; очистка запрещена.`);
    }
    const merged = await execute(['git', '-c', 'core.hooksPath=/dev/null', 'merge-base', '--is-ancestor', head, target], { cwd: repo.source });
    requireThat(merged.code === 0, `${repo.id}: ${repo.branch} ещё не входит в ${mergeRef}. Сначала выполните merge и обновите локальный ref.`);
    repositories.push({ id: repo.id, root, source: repo.source, head, mergeRef, target });
  }
  return { digest: state.digest, fingerprint: state.reviewedFingerprint, repositories };
}

export async function previewCleanup(profilePath, id) {
  return withTask(profilePath, id, async (profile, state, dir) => {
    requireThat(state.workspaceCleanup?.status !== 'done', 'Worktree уже удалён.');
    const plan = await cleanupPlan(profile, state, dir);
    return { ...plan, token: hash(plan) };
  });
}

export async function cleanupAccepted(profilePath, id, { expectedToken, signal } = {}) {
  return withTask(profilePath, id, async (profile, state, dir) => {
    if (state.workspaceCleanup?.status === 'done' && state.workspaceCleanup.token === expectedToken) return state;
    const plan = await cleanupPlan(profile, state, dir);
    requireThat(expectedToken && hash(plan) === expectedToken, 'Пути или merge-ветки изменились после просмотра. Повторите проверку.');
    if (state.snapshot.sandbox) await stopDocker(dir);
    if (!state.workspaceCleanup) {
      await diffReport(dir, state.snapshot);
      state.workspaceCleanup = { status: 'pending', plan, token: expectedToken, removed: [], authorizedAt: now() }; save(dir, state);
    }
    state.workspaceCleanup.plan = plan; state.workspaceCleanup.token = expectedToken; save(dir, state);
    try {
      for (const repo of plan.repositories) {
        if (fs.existsSync(repo.root)) {
          const result = await execute(['git', '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--', repo.root], { cwd: repo.source, signal, timeout: profile.timeoutSeconds,
            audit: auditContext(state, { kind: 'git', operation: 'cleanup' }), ...processTracker(dir, { actor: 'controller', kind: 'git' }) });
          requireThat(result.code === 0 && !result.cancelled && !result.timedOut, result.err || 'Worktree removal interrupted');
        }
        if (!state.workspaceCleanup.removed.includes(repo.id)) state.workspaceCleanup.removed.push(repo.id);
        save(dir, state);
      }
      state.workspaceCleanup.status = 'done'; state.workspaceCleanup.completedAt = now(); delete state.error;
    } catch (error) { state.error = error.message; }
    save(dir, state); return state;
  });
}
