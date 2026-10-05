import fs from 'node:fs';
import path from 'node:path';

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Resolve existing parents too: a new file below a symlink must stay in scope.
export function canonical(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (true) {
    try { fs.lstatSync(cursor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve ${target}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

export function writablePath(root, target, cwd = root) {
  const resolved = canonical(path.resolve(cwd, target));
  if (!inside(root, resolved)) throw new Error(`Write outside current feature: ${target}`);
  if (path.relative(root, resolved).split(path.sep).includes('.git')) {
    throw new Error('Direct writes to .git are disabled; use the Command Center Git workflow.');
  }
  return resolved;
}

export function guardWrite(tool, args, root, cwd = root) {
  if (['edit', 'write'].includes(tool)) {
    if (typeof args.filePath !== 'string') throw new Error('Missing filePath');
    writablePath(root, args.filePath, cwd);
  } else if (['apply_patch', 'patch'].includes(tool)) {
    const patch = args.patchText ?? args.patch;
    if (typeof patch !== 'string') throw new Error('Unknown patch payload');
    const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(x => x[1].trim());
    if (!paths.length) throw new Error('Unsupported patch format');
    paths.forEach(file => writablePath(root, file, cwd));
  } else if (tool === 'multiedit') {
    throw new Error('Use edit/write/apply_patch: multiedit is not supported by this example guard.');
  }
}

export function contextBash() {
  const rules = { '*': 'deny' };
  for (const cmd of ['pwd', 'ls', 'head', 'tail', 'cat', 'wc', 'du', 'df', 'stat', 'file', 'readlink', 'realpath', 'which', 'whoami', 'uname', 'grep', 'rg', 'find', 'diff']) {
    rules[cmd] = 'allow';
    rules[`${cmd} *`] = 'allow';
  }
  for (const cmd of ['git status', 'git diff', 'git log', 'git show', 'git ls-files', 'git ls-tree', 'git rev-parse', 'git branch --show-current']) {
    rules[cmd] = 'allow';
    rules[`${cmd} *`] = 'allow';
  }
  Object.assign(rules, { date: 'allow', 'date -u': 'allow', 'date +*': 'allow' });
  for (const pattern of ['find *-delete*', 'find *-exec*', 'find *-ok*', 'find *-fprint*', 'find *-fprintf*', 'find *-fls*', 'rg *--pre*', 'rg *--hostname-bin*', 'file *-C*', 'file *--compile*', 'git *--output*', 'git *--ext-diff*', 'git *--textconv*', '*>*']) rules[pattern] = 'deny';
  return rules;
}

export function rolePermission(role, readRoots = []) {
  if (role === 'execution-reviewer') return {
    '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
    glob: 'allow', grep: 'allow', execution_submit: 'allow',
    external_directory: Object.fromEntries([['*', 'deny'], ...readRoots.map(root => [`${root.replaceAll('\\', '/')}/*`, 'allow'])]),
  };
  return {
    '*': 'deny',
    read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
    glob: 'allow', grep: 'allow', lsp: 'allow', skill: 'allow',
    webfetch: 'allow', websearch: 'allow',
    bash: contextBash(),
    external_directory: Object.fromEntries([['*', 'deny'], ...readRoots.map(root => [`${root.replaceAll('\\', '/')}/*`, 'allow'])]),
    edit: role === 'builder' || role === 'planner' ? { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask' } : 'deny',
    question: role === 'planner' || role === 'orchestrator' ? 'allow' : 'deny',
    todowrite: 'allow',
    task: role === 'planner' || role === 'orchestrator' ? { '*': 'deny', jira: 'allow' } : 'deny',
    cc_prepare: role === 'planner' ? 'allow' : 'deny',
    cc_status: role === 'planner' || role === 'orchestrator' ? 'allow' : 'deny',
    cc_run: role === 'orchestrator' ? 'allow' : 'deny',
    review_submit: role === 'reviewer' ? 'allow' : 'deny',
    dev_run: role === 'builder' ? 'allow' : 'deny',
    request_user_action: role === 'builder' ? 'allow' : 'deny',
  };
}
