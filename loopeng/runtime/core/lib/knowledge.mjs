import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, status, fingerprint, parseAgentOutput } from './controller.mjs';
import { execute, git } from './process.mjs';
import { canonical, inside } from './policy.mjs';
import { atomicJSON, acquireLease, assertNoWorkers, identity, alive, processTracker } from './recovery.mjs';
import { dockerExecute, stopDocker } from './docker.mjs';
import { agentCommand } from './agent-runtime.mjs';

const must = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const relative = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value)
  && !value.split('/').some(x => !x || x === '..' || x.startsWith('.'));
const permitted = (name, directories) => relative(name) && /\.(md|txt|rst)$/.test(name)
  && directories.some(dir => name.startsWith(dir + '/'));
const kbDir = dir => path.join(dir, 'knowledge-update');
const stateFile = dir => path.join(kbDir(dir), 'state.json');
const save = (dir, value) => atomicJSON(stateFile(dir), { ...value, updated: now() });
const common = async root => canonical(path.resolve(root, (await git(root, 'rev-parse', '--git-common-dir')).trim()));
const safeGit = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'protocol.ext.allow=never'];
async function command(root, argv, options = {}) {
  const result = await execute([...safeGit, ...argv], { cwd: root, timeout: 120, ...options });
  must(result.code === 0 && !result.cancelled && !result.timedOut && !result.limited, result.err || 'Knowledge Git command interrupted');
  return result.out.trim();
}
async function gitlink(root, revision, submodule) {
  const entry = (await git(root, 'ls-tree', '-z', revision, '--', submodule)).split('\0').filter(Boolean);
  must(entry.length === 1 && entry[0].endsWith('\t' + submodule) && /^160000 commit [a-f0-9]+\t/.test(entry[0]), 'Knowledge path must be a committed Git submodule');
  return entry[0].split('\t')[0].split(' ')[2];
}
async function worktree(source, root, base, branch) {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    await command(source, ['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), root, base]);
  }
  must(canonical(root) === root && await common(root) === await common(source), 'Knowledge worktree identity changed');
  must((await git(root, 'rev-parse', 'HEAD')).trim() === base, 'Knowledge worktree HEAD changed');
  must((await git(root, 'branch', '--show-current')).trim() === (branch ?? ''), 'Knowledge branch changed');
}

export async function prepareKnowledge(profile, id) {
  if (!profile.knowledgeBase) return undefined;
  must(profile.sandbox?.kind === 'docker' && profile.agentRuntime?.kind === 'pi', 'knowledgeBase requires pi with Docker');
  const spec = profile.knowledgeBase;
  must(relative(spec.submodule), 'knowledgeBase.submodule must be an explicit relative path');
  must(Array.isArray(spec.writablePaths) && spec.writablePaths.length && spec.writablePaths.every(relative), 'Set knowledgeBase.writablePaths to explicit directories');
  const checks = spec.checks ?? [];
  must(Array.isArray(checks) && checks.every(argv => Array.isArray(argv) && argv.length && argv.every(x => typeof x === 'string' && !x.includes('\0'))), 'Knowledge checks must be argv arrays');
  const source = path.resolve(profile.commandCenter, spec.submodule);
  must(canonical(source) === source && inside(profile.commandCenter, source) && source !== profile.commandCenter, 'Symlinked knowledge submodule is unsupported');
  const ccBase = (await git(profile.commandCenter, 'rev-parse', 'HEAD')).trim();
  const base = await gitlink(profile.commandCenter, ccBase, spec.submodule);
  must((await git(source, 'rev-parse', 'HEAD')).trim() === base && !(await git(source, 'status', '--porcelain')).trim(), 'Knowledge checkout must be clean at the SHA pinned by Command Center');
  const root = path.join(profile.stateRoot, id, 'knowledge-base');
  await worktree(source, root, base);
  for (const name of spec.writablePaths) {
    const folder = path.join(root, name);
    must(canonical(folder) === folder && fs.statSync(folder).isDirectory(), `Knowledge directory must exist without symlinks: ${name}`);
  }
  return { source, root, base, ccBase, ccRoot: profile.commandCenter, ccCommon: await common(profile.commandCenter), common: await common(source),
    submodule: spec.submodule, writablePaths: spec.writablePaths, checks };
}

export function proposeKnowledge(dir, proposals) {
  const s = read(path.join(dir, 'state.json')), kb = s.snapshot.knowledgeBase;
  must(kb && s.status === 'building' && s.approved?.digest === s.digest && hash(s.snapshot) === s.digest, 'Knowledge proposals require the approved Builder task');
  must(Array.isArray(proposals) && proposals.length <= 9, 'Submit up to nine knowledge proposals');
  const ids = new Set();
  for (const p of proposals) {
    must(typeof p.id === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(p.id) && !ids.has(p.id), 'Use unique knowledge proposal IDs'); ids.add(p.id);
    for (const key of ['title', 'reason', 'evidence']) must(typeof p[key] === 'string' && p[key].trim() && p[key].length <= 8000, `Invalid proposal ${key}`);
    must(Array.isArray(p.paths) && p.paths.length && p.paths.length <= 20 && p.paths.every(x => permitted(x, kb.writablePaths)), 'Propose explicit .md/.txt/.rst files inside permitted KB directories');
  }
  atomicJSON(path.join(dir, 'knowledge-proposals.json'), { round: s.round, digest: s.digest, proposals, at: now() });
  return { proposed: proposals.length, message: 'Предложения сохранены. База остаётся RO до одобрения пользователя.' };
}
function proposalsFor(dir, state) {
  const file = path.join(dir, 'knowledge-proposals.json');
  if (!fs.existsSync(file)) return [];
  const p = read(file);
  return p.digest === state.digest && p.round === state.round ? p.proposals : [];
}

// A private copy keeps delayed KB work independent from code publication/cleanup.
// Reflinks are used where the filesystem supports them; ignored build caches are excluded.
export async function captureKnowledgeEvidence(dir, state) {
  if (!state.snapshot.knowledgeBase) return;
  const proposals = proposalsFor(dir, state);
  if (!proposals.length) return;
  if (fs.existsSync(stateFile(dir))) {
    const previous = read(stateFile(dir));
    if (previous.fingerprint === state.reviewedFingerprint && previous.status !== 'capture_failed') return;
  }
  const folder = kbDir(dir), featureRoot = path.join(folder, 'code');
  fs.mkdirSync(folder, { recursive: true });
  try {
    must(await fingerprint(state.snapshot) === state.reviewedFingerprint, 'Accepted code changed before KB evidence capture');
    fs.rmSync(featureRoot, { recursive: true, force: true }); fs.mkdirSync(featureRoot);
    const repos = [];
    for (const repo of state.snapshot.repos) {
      const root = path.join(featureRoot, repo.id); fs.mkdirSync(root);
      const files = [...new Set((await git(repo.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean))];
      for (const name of files) {
        const from = path.join(repo.root, name), to = path.join(root, name);
        must(inside(root, to) && !name.split('/').includes('.git'), 'Invalid source file in KB evidence');
        if (!fs.existsSync(from) && !fs.lstatSync(from, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
        const st = fs.lstatSync(from); fs.mkdirSync(path.dirname(to), { recursive: true });
        if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
        else { must(st.isFile(), 'Unsupported source entry'); fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE); fs.chmodSync(to, st.mode & 0o777); }
      }
      fs.writeFileSync(path.join(root, '.git'), ''); repos.push({ ...repo, root });
    }
    must(await fingerprint(state.snapshot) === state.reviewedFingerprint, 'Code changed during KB evidence capture');
    const evidence = { digest: state.digest, fingerprint: state.reviewedFingerprint, plan: state.snapshot.plan, proposals,
      builder: state.builderSummary, review: state.review, checks: state.checkResults };
    atomicJSON(path.join(folder, 'evidence.json'), evidence);
    const token = hash({ evidence, base: state.snapshot.knowledgeBase });
    save(dir, { status: 'proposed', token, fingerprint: state.reviewedFingerprint, proposals, evidence,
      snapshot: { ...state.snapshot, featureRoot, repos }, created: now() });
  } catch (error) {
    save(dir, { status: 'capture_failed', error: error.message, fingerprint: state.reviewedFingerprint, proposals });
  }
}

export function knowledgeStatus(dir) {
  if (!fs.existsSync(stateFile(dir))) return undefined;
  const k = read(stateFile(dir)), file = path.join(kbDir(dir), 'job.json');
  const job = fs.existsSync(file) ? read(file) : undefined;
  return { ...k, job: job ? { ...job, alive: ['starting', 'running'].includes(job.status) && alive(job.owner) } : undefined };
}
function locate(profilePath, id) {
  const profile = loadProfile(profilePath), s = status(profilePath, id), dir = path.join(profile.stateRoot, s.id);
  must(s.snapshot.knowledgeBase, 'Для этой задачи база знаний не настроена');
  return { profile, s, dir };
}
export function previewKnowledge(profilePath, id) {
  const { s, dir } = locate(profilePath, id), k = knowledgeStatus(dir);
  return k ?? { status: s.status === 'accepted' ? 'empty' : 'awaiting_acceptance', proposals: proposalsFor(dir, s),
    ...(s.status === 'accepted' ? {} : { error: 'Сначала примите код. Обновление базы необязательно.' }) };
}
function checkEvidence(dir, k) {
  const main = read(path.join(dir, 'state.json'));
  must(main.status === 'accepted' && main.reviewedFingerprint === k.fingerprint && main.digest === k.evidence.digest
    && main.approved?.digest === main.digest && hash(main.snapshot) === main.digest, 'Knowledge approval belongs to a different accepted result');
  must(k.token === hash({ evidence: k.evidence, base: main.snapshot.knowledgeBase }), 'Knowledge proposal or evidence changed');
  must(hash(k.proposals) === hash(k.evidence.proposals), 'Knowledge proposals changed');
  return main;
}
export function knowledgeWorkerState(folder) {
  const dir = path.dirname(folder), k = read(path.join(folder, 'state.json'));
  const main = checkEvidence(dir, k);
  must(k.status === 'running' && k.approval?.token === k.token && hash(k.approval) === k.approvalHash, 'Knowledge update needs explicit current approval');
  const selected = k.proposals.filter(x => k.approval.ids.includes(x.id));
  must(selected.length === k.approval.ids.length && selected.length, 'Invalid approved proposals');
  const paths = [...new Set(selected.flatMap(p => p.paths))];
  must(hash(paths) === hash(k.snapshot.knowledgeUpdate.paths), 'Knowledge write scope changed');
  // All execution settings except private code roots and KB worktree come from the approved main snapshot.
  const expectedRoot = path.join(folder, 'code');
  const expected = { ...main.snapshot, featureRoot: expectedRoot,
    repos: main.snapshot.repos.map(r => ({ ...r, root: path.join(expectedRoot, r.id) })),
    knowledgeBase: { ...main.snapshot.knowledgeBase, root: path.join(folder, 'worktree') }, knowledgeUpdate: { paths } };
  must(hash(k.snapshot) === hash(expected), 'Knowledge execution snapshot changed');
  return { ...main, status: 'running', snapshot: k.snapshot, knowledgeStage: true, approvedProposals: selected };
}

async function withKnowledge(profilePath, id, fn) {
  const located = locate(profilePath, id), folder = kbDir(located.dir);
  fs.mkdirSync(folder, { recursive: true });
  const release = acquireLease(path.join(folder, '.lock'));
  try { assertNoWorkers(folder); return await fn({ ...located, folder, k: knowledgeStatus(located.dir) }); }
  finally { release(); }
}
export async function retryKnowledgeCapture(profilePath, id) {
  return withKnowledge(profilePath, id, async ({ s, dir, k }) => {
    must(s.status === 'accepted' && k?.status === 'capture_failed', 'Повтор снимка сейчас недоступен');
    await captureKnowledgeEvidence(dir, s); return knowledgeStatus(dir);
  });
}
export async function feedbackKnowledge(profilePath, id, { fingerprint: expected, text } = {}) {
  return withKnowledge(profilePath, id, async ({ dir, k }) => {
    must(k?.status === 'ready' && !k.publication, 'Исправления доступны до публикации базы');
    checkEvidence(dir, k);
    must(expected === k.checkedFingerprint && hash(await changedFiles(k)) === expected, 'Diff базы изменился; откройте его заново');
    must(typeof text === 'string' && text.trim() && text.length <= 8000, 'Введите замечания к документации');
    k.feedback = text.trim(); k.status = 'approved'; save(dir, k); return k;
  });
}
export async function decideKnowledge(profilePath, id, { expectedToken, ids = [], reject = false } = {}) {
  return withKnowledge(profilePath, id, async ({ s, dir, k }) => {
    must(k && ['proposed', 'rejected'].includes(k.status), 'Предложения сейчас недоступны для одобрения');
    checkEvidence(dir, k); must(expectedToken === k.token, 'Предложения изменились; откройте их заново');
    if (reject) { k.status = 'rejected'; save(dir, k); return k; }
    must(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length && ids.every(x => k.proposals.some(p => p.id === x)), 'Выберите предложения для обновления');
    const kb = s.snapshot.knowledgeBase;
    must(await gitlink(kb.ccRoot, 'HEAD', kb.submodule) === kb.base, 'База в CC обновилась; нужен новый план предложений');
    const paths = [...new Set(k.proposals.filter(x => ids.includes(x.id)).flatMap(x => x.paths))];
    k.snapshot.knowledgeBase = { ...kb, root: path.join(kbDir(dir), 'worktree') };
    k.snapshot.knowledgeUpdate = { paths };
    k.approval = { token: k.token, ids, at: now() }; k.approvalHash = hash(k.approval); k.status = 'approved'; save(dir, k); return k;
  });
}

async function changedFiles(k) {
  const kb = k.snapshot.knowledgeBase, root = kb.root;
  must(canonical(root) === root && await common(root) === kb.common, 'Knowledge worktree changed');
  must((await git(root, 'branch', '--show-current')).trim() === k.branch, 'Knowledge worktree branch changed');
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  must(head === kb.base || head === k.publication?.records?.kb?.head, 'Knowledge worktree HEAD changed');
  const names = new Set((await git(root, 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', kb.base, '--')).split('\0').filter(Boolean));
  for (const name of (await git(root, 'ls-files', '-z', '--others', '--exclude-standard')).split('\0').filter(Boolean)) names.add(name);
  // Untracked ignored files are not silently omitted from KB scope validation.
  for (const name of (await git(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard')).split('\0').filter(Boolean)) names.add(name);
  const files = [];
  for (const name of [...names].sort()) {
    must(permitted(name, kb.writablePaths) && k.snapshot.knowledgeUpdate.paths.includes(name), `Knowledge changed outside approved files: ${name}`);
    const file = path.join(root, name), st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) { files.push({ path: name, deleted: true }); continue; }
    must(canonical(file) === file && st.isFile() && st.size <= 2 * 1024 * 1024, `Unsupported knowledge file: ${name}`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    must(!content.includes('\0'), 'Knowledge files must be text');
    files.push({ path: name, content, mode: st.mode & 0o777 });
  }
  return files;
}

export async function runKnowledge(profilePath, id, { signal } = {}) {
  return withKnowledge(profilePath, id, async ({ dir, folder, k }) => {
    must(k && ['approved', 'running', 'failed'].includes(k.status) && !k.publication, 'Одобрите обновление базы или возобновите прерванный запуск');
    checkEvidence(dir, k);
    const kb = k.snapshot.knowledgeBase;
    try {
      must(await gitlink(kb.ccRoot, 'HEAD', kb.submodule) === kb.base, 'База в CC изменилась; обновление остановлено');
      await stopDocker(folder);
      k.branch = `feature/${id}-knowledge-${k.token.slice(0, 8)}`;
      await worktree(kb.source, kb.root, kb.base, k.branch);
      k.status = 'running'; delete k.error; save(dir, k);
      const context = knowledgeWorkerState(folder);
      const argv = [...agentCommand(k.snapshot.profile, { directory: k.snapshot.featureRoot, role: 'builder', session: k.session }), '--knowledge-update'];
      const prompt = `Update only the approved knowledge files. Code is accepted and read-only. Do not implement code or change the plan.\nAPPROVED PROPOSALS\n${JSON.stringify(context.approvedProposals)}\nEVIDENCE\n${JSON.stringify(k.evidence)}\nUSER FEEDBACK\n${k.feedback ?? 'None'}\nKnowledge paths: /knowledge. Accepted code: /workspace. Inspect current files before writing, including after a resumed session. Finish with a concise summary.`;
      fs.writeFileSync(path.join(folder, 'prompt.txt'), prompt);
      const result = await execute(argv, { cwd: k.snapshot.featureRoot, signal, input: prompt, timeout: k.snapshot.profile.timeoutSeconds,
        env: { CC_RUN_DIR: folder, CC_PROFILE: profilePath, CC_PI_PARENT: '', CC_WORKER_ROLE: 'builder' },
        log: path.join(folder, `builder-${Date.now()}.log`), ...processTracker(folder, { actor: 'builder', kind: 'knowledge_update' }),
        audit: { root: k.snapshot.profile.stateRoot, stateDir: folder, feature: id, actor: 'builder', kind: 'knowledge_update' },
        onLine(line) { try { const e = JSON.parse(line); if (e.type === 'session' && e.sessionID) { k.session = e.sessionID; save(dir, k); } } catch {} } });
      must(result.code === 0 && !result.cancelled && !result.timedOut && !result.limited, 'Builder базы прерван. Можно продолжить с сохранённой сессией.');
      k.summary = parseAgentOutput(result.out).text;
      const before = await changedFiles(k); k.checks = [];
      for (const argv of kb.checks) {
        const check = await dockerExecute(k.snapshot, folder, argv, { cwd: '/knowledge', role: 'knowledge-check', readonly: true, signal,
          timeout: k.snapshot.profile.timeoutSeconds, log: path.join(folder, `check-${k.checks.length + 1}.log`), ...processTracker(folder, { actor: 'controller', kind: 'knowledge_check' }),
          audit: { root: k.snapshot.profile.stateRoot, stateDir: folder, feature: id, actor: 'controller', kind: 'knowledge_check' } });
        k.checks.push({ argv, passed: check.code === 0 && !check.cancelled && !check.timedOut && !check.limited });
        must(k.checks.at(-1).passed, 'Проверка базы не прошла: ' + check.err);
      }
      k.files = await changedFiles(k); must(hash(k.files) === hash(before), 'Проверка изменила базу');
      k.checkedFingerprint = hash(k.files); k.status = 'ready';
      k.diff = await git(kb.root, 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', kb.base, '--');
      const tracked = new Set((await git(kb.root, 'ls-files', '-z')).split('\0'));
      for (const f of k.files) if (!tracked.has(f.path) && !f.deleted) k.diff += `\n--- /dev/null\n+++ b/${f.path}\n${f.content.split('\n').map(x => '+' + x).join('\n')}\n`;
      fs.writeFileSync(path.join(folder, 'changes.diff'), k.diff);
    } catch (error) { k.status = 'failed'; k.error = error.message; }
    finally { await stopDocker(folder).catch(error => { k.status = 'failed'; k.error = error.message; }); save(dir, k); }
    return k;
  });
}

async function publicationPlan(profile, k, mode) {
  must(profile.git?.allowCommit === true, 'Для публикации базы нужен git.allowCommit=true');
  must(mode === 'commit' || mode === 'push' && profile.git?.allowPush === true, 'Push базы не разрешён профилем');
  const kb = k.snapshot.knowledgeBase;
  must(await common(kb.ccRoot) === kb.ccCommon && await common(kb.source) === kb.common, 'Knowledge Git identity changed');
  must(await gitlink(kb.ccRoot, 'HEAD', kb.submodule) === kb.base, 'Ссылка CC на базу изменилась; публикация остановлена');
  must(k.checkedFingerprint === hash(await changedFiles(k)) && k.files.length, 'База изменилась после проверки или diff пуст');
  const ccBranch = `feature/${path.basename(path.dirname(path.dirname(kb.root)))}-${k.token.slice(0, 8)}-kb-link`;
  const targets = [
    { kind: 'kb', root: kb.root, branch: k.branch, base: kb.base, message: `Update knowledge: ${k.proposals.filter(p => k.approval.ids.includes(p.id)).map(p => p.title).join('; ').slice(0, 500)}` },
    { kind: 'cc', root: kb.ccRoot, branch: ccBranch, base: kb.ccBase, message: `Update ${kb.submodule} reference for reviewed knowledge` },
  ];
  if (mode === 'push') for (const target of targets) {
    const remote = profile.knowledgeBase?.[target.kind === 'kb' ? 'remote' : 'ccRemote'] ?? 'origin';
    const urls = (await git(target.root, 'remote', 'get-url', '--push', '--all', remote)).trim().split('\n');
    must(urls.length === 1 && urls[0] && !urls[0].startsWith('-'), 'Нужен один push URL для базы и CC'); target.remote = remote; target.url = urls[0];
  }
  return { mode, targets, fingerprint: k.checkedFingerprint, approvalHash: k.approvalHash };
}
async function chosenPublicationPlan(profile, k, mode) {
  if (k.publication && !(k.status === 'published' && k.publication.plan.mode === 'commit' && mode === 'push')) return k.publication.plan;
  return publicationPlan(profile, k, mode);
}
export async function previewKnowledgePublication(profilePath, id, { mode = 'commit' } = {}) {
  const { profile, dir } = locate(profilePath, id), k = knowledgeStatus(dir);
  must(k && ['ready', 'publishing', 'published', 'publication_failed'].includes(k.status), 'Сначала подготовьте diff базы');
  checkEvidence(dir, k);
  const plan = await chosenPublicationPlan(profile, k, mode);
  const done = k.status === 'published' && k.publication.plan.mode === plan.mode;
  return { ...plan, token: hash(plan), status: k.status, done, records: k.publication?.records, diff: k.diff,
    submodule: k.snapshot.knowledgeBase.submodule, oldPin: k.snapshot.knowledgeBase.base,
    files: k.files, checks: k.checks, canPush: profile.git?.allowPush === true, pending: !!k.publication && k.status !== 'published' };
}
export async function publishKnowledge(profilePath, id, { expectedToken, mode = 'commit', signal } = {}) {
  return withKnowledge(profilePath, id, async ({ profile, dir, folder, k }) => {
    must(k && ['ready', 'publishing', 'publication_failed', 'published'].includes(k.status), 'Сначала подготовьте diff базы');
    checkEvidence(dir, k);
    const plan = await chosenPublicationPlan(profile, k, mode);
    must(expectedToken === hash(plan), 'Публикация базы изменилась; откройте preview заново');
    const current = await publicationPlan(profile, k, plan.mode);
    must(hash(current) === hash(plan), 'Назначения публикации изменились');
    if (k.status === 'published' && k.publication.plan.mode === plan.mode) return k;
    k.publication = { ...k.publication, plan, records: k.publication?.records ?? {} }; k.status = 'publishing'; save(dir, k);
    const kb = k.snapshot.knowledgeBase;
    const opts = { signal, timeout: profile.timeoutSeconds,
      audit: { root: profile.stateRoot, stateDir: folder, feature: id, actor: 'controller', kind: 'knowledge_git' },
      ...processTracker(folder, { actor: 'controller', kind: 'knowledge_git' }) };
    try {
      for (const target of plan.targets) {
        must(k.checkedFingerprint === hash(await changedFiles(k)), 'База изменилась после проверки');
        must(await gitlink(kb.ccRoot, 'HEAD', kb.submodule) === kb.base, 'Ссылка CC на базу изменилась');
        let record = k.publication.records[target.kind];
        if (!record) {
          const index = path.join(folder, `index-${target.kind}-${crypto.randomUUID()}`), env = { GIT_INDEX_FILE: index };
          try {
            await command(target.root, ['read-tree', target.base], { ...opts, env });
            // Stage the reviewed bytes, avoiding clean filters and concurrent worktree edits.
            if (target.kind === 'kb') for (const file of k.files) {
              if (file.deleted) await command(target.root, ['update-index', '--force-remove', '--', file.path], { ...opts, env });
              else {
                const blob = await command(target.root, ['hash-object', '-w', '--stdin', '--no-filters'], { ...opts, input: file.content });
                await command(target.root, ['update-index', '--add', '--cacheinfo', `${file.mode & 0o111 ? '100755' : '100644'},${blob},${file.path}`], { ...opts, env });
              }
            }
            else await command(target.root, ['update-index', '--add', '--cacheinfo', `160000,${k.publication.records.kb.head},${kb.submodule}`], { ...opts, env });
            const tree = await command(target.root, ['write-tree'], { ...opts, env });
            const head = await command(target.root, ['commit-tree', tree, '-p', target.base, '-m', target.message], opts);
            record = k.publication.records[target.kind] = { head, status: 'created' }; save(dir, k);
          } finally { fs.rmSync(index, { force: true }); fs.rmSync(index + '.lock', { force: true }); }
        }
        const ref = `refs/heads/${target.branch}`;
        must(k.checkedFingerprint === hash(await changedFiles(k)), 'База изменилась перед коммитом');
        const found = await execute([...safeGit, 'rev-parse', '--verify', ref], { cwd: target.root });
        const prior = found.code === 0 ? found.out.trim() : '0'.repeat(record.head.length);
        must(prior === record.head || prior === (target.kind === 'kb' ? target.base : '0'.repeat(record.head.length)), 'Ветка публикации базы изменена извне');
        if (prior !== record.head) await command(target.root, ['update-ref', ref, record.head, prior], opts);
        // Synchronize only the controller-owned KB worktree index; source/submodule indexes are untouched.
        if (target.kind === 'kb') await command(target.root, ['read-tree', record.head], opts);
        record.status = 'committed'; save(dir, k);
        if (plan.mode === 'push') {
          must((await git(target.root, 'remote', 'get-url', '--push', '--all', target.remote)).trim() === target.url, 'Push URL changed');
          await command(target.root, ['push', '--porcelain', '--no-follow-tags', '--no-verify', '--recurse-submodules=no', '--', target.url, `${record.head}:${ref}`], { ...opts, env: { GIT_TERMINAL_PROMPT: '0' } });
          record.status = 'pushed'; save(dir, k);
        }
      }
      k.status = 'published'; delete k.error;
    } catch (error) { k.status = 'publication_failed'; k.error = error.message; }
    save(dir, k); return k;
  });
}

export async function startKnowledgeJob(profilePath, id, { action = 'update', ...approval } = {}) {
  must(['update', 'publish'].includes(action), 'Invalid knowledge action');
  const { dir } = locate(profilePath, id), folder = kbDir(dir);
  fs.mkdirSync(folder, { recursive: true });
  const release = acquireLease(path.join(folder, '.launch-lock'));
  try {
    const previous = knowledgeStatus(dir);
    if (previous?.job?.alive) return previous.job;
    assertNoWorkers(folder);
    const token = crypto.randomUUID(), log = path.join(folder, `runner-${token}.log`), file = path.join(folder, 'job.json');
    atomicJSON(file, { token, action, ...approval, status: 'starting', owner: identity(), log });
    const fd = fs.openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../knowledge-runner.mjs', import.meta.url)), profilePath, id, token], {
      cwd: folder, stdio: ['ignore', fd, fd], detached: true }); fs.closeSync(fd);
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); }); }
    catch (error) { atomicJSON(file, { token, status: 'failed', error: error.message }); throw error; }
    const job = { token, action, ...approval, status: 'running', owner: identity(child.pid), log };
    atomicJSON(file, job); child.unref(); return job;
  } finally { release(); }
}
export function stopKnowledgeJob(profilePath, id) {
  const { dir } = locate(profilePath, id), job = knowledgeStatus(dir)?.job;
  must(job?.alive, 'Обновление базы сейчас не выполняется'); process.kill(job.owner.pid, 'SIGTERM');
}
