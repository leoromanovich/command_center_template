import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, inside } from './policy.mjs';
import { execute, git } from './process.mjs';
import { acquireLease, assertNoWorkers, processTracker, Interrupted } from './recovery.mjs';

const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const safeName = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !/[\0\r\n]/.test(value);
const gitArgs = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'protocol.ext.allow=never'];

async function command(cwd, args, { profile, dir, id, signal, network = false, round = 0, auditDir = dir }) {
  const log = path.join(dir, `git-${crypto.randomUUID()}.log`);
  const result = await execute([...gitArgs, ...args], { cwd, signal, timeout: profile.timeoutSeconds,
    env: { GIT_TERMINAL_PROMPT: '0' }, log,
    audit: { root: profile.stateRoot, stateDir: auditDir, feature: id, round, actor: 'controller', kind: 'git' },
    ...processTracker(dir, { actor: 'controller', kind: 'git', log }) });
  if (result.code !== 0 || result.timedOut || result.cancelled || result.limited) {
    const message = `Git ${args[0]} failed: ${(result.err || result.out).slice(-4000)}`;
    if (network || result.timedOut || result.cancelled) throw new Interrupted(message);
    throw new Error(message);
  }
  return result.out.trim();
}

export function featureBranch(branch, prefix = 'feature/') {
  requireThat(safeName(prefix) && prefix.endsWith('/') && prefix.length > 1, 'Git branchPrefix must be a non-empty namespace ending in /');
  requireThat(safeName(branch) && branch.startsWith(prefix) && branch.length > prefix.length, `Use a feature branch under ${prefix}`);
}

export async function ignoreWorkspace(profile, target) {
  if (!inside(profile.commandCenter, target)) return;
  const relative = path.relative(profile.commandCenter, target).split(path.sep).join('/');
  requireThat(relative && !/[\n\r\0*?\[\]\\!#]/.test(relative), 'Unsafe nested workspace directory');
  const probe = await execute([...gitArgs, 'rev-parse', '--show-toplevel'], { cwd: profile.commandCenter });
  if (probe.code === 0) requireThat(!(await git(profile.commandCenter, 'ls-files', '--', relative)).trim(), `Workspace path is already tracked by Command Center: ${relative}`);
  const file = path.join(profile.commandCenter, '.gitignore');
  requireThat(canonical(file) === file, 'Symlinked Command Center .gitignore is unsupported');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rule = `/${relative}/`;
  if (!text.split(/\r?\n/).includes(rule)) fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${rule}\n`);
  if (probe.code === 0) {
    const check = await execute([...gitArgs, 'check-ignore', '-q', '--', `${relative}/.cc-ignore-probe`], { cwd: profile.commandCenter });
    requireThat(check.code === 0, `Command Center does not ignore ${relative}; inspect .gitignore rules`);
  }
}

// Only configured sources/URLs and task feature branches can be provisioned.
export async function ensureWorktrees(profile, task, featureRoot) {
  if (!profile.workspace?.autoCreate) return;
  const dir = path.join(profile.stateRoot, task.id);
  fs.mkdirSync(profile.stateRoot, { recursive: true });
  const release = acquireLease(path.join(profile.stateRoot, '.workspace-lock'));
  try {
    const setupDir = path.join(profile.stateRoot, 'workspace-processes');
    assertNoWorkers(setupDir);
    fs.mkdirSync(setupDir, { recursive: true });
    const ctx = { profile, dir: setupDir, auditDir: dir, id: task.id };
    const entries = task.repositories.map(id => {
      const item = profile.repositories[id];
      requireThat(item && typeof item.source === 'string' && typeof item.worktree === 'string', `Unknown/unconfigured repository: ${id}`);
      const source = canonical(path.resolve(profile.commandCenter, item.source));
      const root = path.resolve(featureRoot, item.worktree);
      requireThat(canonical(root) === root && inside(featureRoot, root) && root !== featureRoot, `Invalid worktree path: ${id}`);
      requireThat(!path.relative(featureRoot, root).split(path.sep).includes('.git'), `Invalid Git metadata path: ${id}`);
      requireThat(!inside(profile.worktreeParent, source) && !inside(source, profile.commandCenter), `Source overlaps workspace or Command Center: ${id}`);
      const selection = task.worktrees?.[id] ?? {};
      const branch = selection.branch ?? `${item.git?.branchPrefix ?? 'feature/'}${task.id}`;
      const base = selection.base ?? item.baseRef;
      if (!fs.existsSync(root) || selection.branch) featureBranch(branch, item.git?.branchPrefix);
      requireThat(!selection.fetch || safeName(item.git?.remote ?? 'origin'), `Invalid fetch remote: ${id}`);
      return { id, item, source, root, selection, branch, base };
    });
    for (const a of entries) for (const b of entries) if (a !== b) requireThat(!inside(a.root, b.root), 'Overlapping worktree paths');
    // A prepared/running task may only be inspected here. Never fetch or add trees for it.
    const prepared = fs.existsSync(path.join(dir, 'state.json'));
    if (prepared) {
      for (const e of entries) requireThat(fs.existsSync(e.root), 'Prepared worktree is missing; recover it before continuing');
      return;
    }
    await ignoreWorkspace(profile, profile.worktreeParent);
    await ignoreWorkspace(profile, profile.stateRoot);
    for (const e of entries) {
      const { id, item, source, root, selection, branch, base } = e;
      if (!fs.existsSync(source)) {
        requireThat(profile.workspace.cloneMissing === true && safeName(item.cloneUrl), `${id}: source missing; configure workspace.cloneMissing and cloneUrl`);
        await ignoreWorkspace(profile, source);
        fs.mkdirSync(path.dirname(source), { recursive: true });
        await command(path.dirname(source), ['clone', '--no-hardlinks', '--no-checkout', '--', item.cloneUrl, source], { ...ctx, network: true });
      }
      await git(source, 'rev-parse', '--git-common-dir');
      if (fs.existsSync(root)) {
        if (selection.branch) requireThat((await git(root, 'branch', '--show-current')).trim() === branch, `${id}: existing worktree has another branch`);
        continue;
      }
      requireThat(safeName(base), `${id}: specify worktrees.${id}.base or repositories.${id}.baseRef`);
      await git(source, 'check-ref-format', '--branch', branch);
      if (selection.fetch === true) await command(source, ['fetch', '--no-tags', '--', item.git?.remote ?? 'origin'], { ...ctx, network: true });
      const baseHead = (await git(source, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)).trim();
      const exists = await execute([...gitArgs, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: source });
      if (exists.code === 0) {
        requireThat(selection.reuseBranch === true, `${id}: branch already exists; explicitly set reuseBranch or choose a new feature branch`);
        await git(source, 'merge-base', '--is-ancestor', baseHead, `refs/heads/${branch}`);
      } else requireThat(exists.code === 1, `${id}: cannot inspect branch`);
      fs.mkdirSync(path.dirname(root), { recursive: true });
      await command(source, exists.code === 0 ? ['worktree', 'add', '--', root, branch]
        : ['worktree', 'add', '-b', branch, '--', root, baseHead], ctx);
    }
  } finally { release(); }
}

export async function gitPublication(profile, task, repos) {
  const commit = task.publication?.commit === true, push = task.publication?.push === true;
  requireThat(!push || commit, 'publication.push requires publication.commit');
  if (!commit) return undefined;
  requireThat(profile.git?.allowCommit === true, 'Enable profile.git.allowCommit for automatic commits');
  requireThat(!push || profile.git?.allowPush === true, 'Enable profile.git.allowPush for automatic push');
  const targets = [];
  for (const repo of repos) {
    const settings = profile.repositories[repo.id].git ?? {};
    if (settings.allowedBranches !== undefined) requireThat(Array.isArray(settings.allowedBranches) && settings.allowedBranches.every(safeName), 'git.allowedBranches must be an array of literal branch names');
    // Explicit names support pre-existing feature branches outside the default namespace.
    if (settings.allowedBranches?.includes(repo.branch)) {
      requireThat(!['main', 'master', 'develop'].includes(repo.branch) && repo.branch !== profile.repositories[repo.id].baseRef, 'Protected/base branches cannot be published by this workflow');
    } else featureBranch(repo.branch, settings.branchPrefix);
    await git(repo.root, 'check-ref-format', '--branch', repo.branch);
    let remote, url;
    if (push) {
      remote = settings.remote ?? 'origin'; requireThat(safeName(remote), 'Invalid Git remote');
      const urls = (await git(repo.root, 'remote', 'get-url', '--push', '--all', remote)).trim().split('\n');
      requireThat(urls.length === 1 && safeName(urls[0]), 'Push needs exactly one configured remote URL');
      url = urls[0];
    }
    targets.push({ repo: repo.id, branch: repo.branch, remote, url });
  }
  return { commit, push, targets };
}

async function verifyIndex(root) {
  const format = (await git(root, 'rev-parse', '--show-object-format')).trim();
  requireThat(['sha1', 'sha256'].includes(format), 'Unsupported Git object format');
  for (const entry of (await git(root, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, oid, stage] = entry.slice(0, tab).split(' '), name = entry.slice(tab + 1);
    requireThat(stage === '0', 'Unmerged Git index');
    const file = path.join(root, name), info = fs.lstatSync(file);
    requireThat(info.isFile() || info.isSymbolicLink(), 'Unsupported indexed file');
    const link = info.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : undefined;
    const hash = crypto.createHash(format).update(`blob ${link?.length ?? info.size}\0`);
    if (link) hash.update(link); else for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    requireThat(hash.digest('hex') === oid, `Git clean filter changes reviewed bytes: ${name}. Normalize and review the stored form before committing.`);
    requireThat(mode === (link ? '120000' : info.mode & 0o111 ? '100755' : '100644'), `Git index mode differs from reviewed file: ${name}`);
  }
}

// Commit objects are persisted before the branch CAS; push always names one exact SHA/ref.
export async function publishGit(dir, state, { save, fingerprint, signal, spec = state.snapshot.publication.git }) {
  if (!spec) return;
  const profile = state.snapshot.profile;
  state.gitPublication ??= {}; state.publishedHeads ??= {};
  for (const target of spec.targets) {
    const repo = state.snapshot.repos.find(r => r.id === target.repo);
    const ctx = { profile, dir, id: state.id, round: state.round, signal };
    requireThat(canonical(repo.root) === repo.root, 'Git worktree path changed');
    requireThat(canonical(path.resolve(repo.root, (await git(repo.root, 'rev-parse', '--git-common-dir')).trim())) === repo.common, 'Git worktree identity changed');
    requireThat((await git(repo.root, 'branch', '--show-current')).trim() === target.branch, 'Git feature branch changed');
    requireThat(await fingerprint(state.snapshot) === state.reviewedFingerprint, 'Reviewed files changed before Git publication');
    let record = state.gitPublication[repo.id];
    let head = (await git(repo.root, 'rev-parse', 'HEAD')).trim();
    const expected = state.publishedHeads[repo.id] ?? repo.base;
    if (record?.fingerprint !== state.reviewedFingerprint) {
      requireThat(!record || record.status === 'done', 'Previous Git publication is incomplete; resume it first');
      requireThat(head === expected, 'HEAD changed outside the approved Git workflow');
      record = { fingerprint: state.reviewedFingerprint, parent: head, status: 'staging', message: spec.messages?.[repo.id] };
      state.gitPublication[repo.id] = record; save(dir, state);
    }
    requireThat(head === record.parent || head === record.head, 'Unexpected HEAD during Git recovery');
    if (!record.head) {
      await command(repo.root, ['add', '--all', '--', '.'], ctx);
      const tree = await command(repo.root, ['write-tree'], ctx);
      await verifyIndex(repo.root);
      requireThat(await fingerprint(state.snapshot) === state.reviewedFingerprint, 'Files changed while staging');
      const previousTree = (await git(repo.root, 'rev-parse', `${record.parent}^{tree}`)).trim();
      record.tree = tree;
      record.head = tree === previousTree ? record.parent : await command(repo.root,
        ['commit-tree', tree, '-p', record.parent, '-m', record.message ?? `Implement ${state.id} (${repo.id})\n\nCommand-Center: ${state.digest}\nReviewed: ${state.reviewedFingerprint}`], ctx);
      record.status = 'commit_created'; save(dir, state);
    }
    if (head !== record.head) await command(repo.root, ['update-ref', '-m', `Command Center: ${state.id}`, `refs/heads/${target.branch}`, record.head, record.parent], ctx);
    head = record.head;
    state.publishedHeads[repo.id] = head; record.status = record.status === 'done' ? 'done' : 'committed'; save(dir, state);
    if (spec.push) {
      const urls = (await git(repo.root, 'remote', 'get-url', '--push', '--all', target.remote)).trim();
      requireThat(urls === target.url, 'Push remote URL changed since plan approval');
      const ref = `refs/heads/${target.branch}`;
      const remoteHead = async () => {
        const lines = await command(repo.root, ['ls-remote', '--refs', '--', target.url, ref], { ...ctx, network: true });
        return lines.split('\n').find(line => line.split('\t')[1] === ref)?.split('\t')[0];
      };
      if (await remoteHead() !== head) {
        record.status = 'pushing'; save(dir, state);
        await command(repo.root, ['push', '--porcelain', '--no-follow-tags', '--no-verify', '--recurse-submodules=no', '--', target.url, `${head}:${ref}`], { ...ctx, network: true });
        requireThat(await remoteHead() === head, 'Remote branch changed during push; inspect it before resuming');
      }
    }
    record.status = 'done'; save(dir, state);
  }
}

// Only a clean, never-started feature may advance to the pinned descendant commit.
export async function inspectBase(repo, target, { recovering = false } = {}) {
  requireThat(canonical(repo.root) === repo.root, 'Git worktree path changed');
  requireThat(canonical(path.resolve(repo.root, (await git(repo.root, 'rev-parse', '--git-common-dir')).trim())) === repo.common, 'Git worktree identity changed');
  requireThat((await git(repo.root, 'branch', '--show-current')).trim() === repo.branch, 'Git feature branch changed');
  const head = (await git(repo.root, 'rev-parse', 'HEAD')).trim();
  requireThat(head === target.from || (recovering && head === target.to), `${repo.id}: worktree has local commits or unexpected HEAD`);
  requireThat(!(await git(repo.root, 'status', '--porcelain', '--untracked-files=all', '--ignored')).trim(), `${repo.id}: worktree must be clean, including untracked and ignored files`);
  await git(repo.root, 'merge-base', '--is-ancestor', target.from, target.to);
  return head;
}

export async function advanceBase(dir, state, repo, target, signal) {
  const head = await inspectBase(repo, target, { recovering: true });
  if (head !== target.to) await command(repo.root,
    ['merge', '--ff-only', '--no-autostash', '--no-edit', '--no-overwrite-ignore', target.to],
    { profile: state.snapshot.profile, dir, id: state.id, signal });
  requireThat((await inspectBase(repo, target, { recovering: true })) === target.to, 'Base did not advance to the pinned commit');
}
