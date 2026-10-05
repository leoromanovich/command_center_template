import fs from 'node:fs';
import path from 'node:path';
import { canonical, inside } from './policy.mjs';

// Deliberately a literal argv reader, not a general shell parser. New permission
// forms must never depend on the shell expanding or choosing the Git operation.
function literalArgs(command) {
  const args = [];
  let value = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (/[\x00-\x1f\x7f]/.test(char)) throw new Error('Git context: use one command per Bash call; control characters are unsupported.');
    if (quote === "'") {
      if (char === "'") quote = ''; else value += char;
    } else if (char === '\\') {
      const next = command[++i];
      if (!next || /[\x00-\x1f\x7f]/.test(next)) throw new Error('Git context: invalid escape.');
      value += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
      started = true;
    } else if (char === '$' || char === '`') {
      throw new Error('Git context: shell expansions are unsupported; use literal arguments.');
    } else if (quote === '"') {
      if (char === '"') quote = ''; else value += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (char === ' ') {
      if (started) { args.push(value); value = ''; started = false; }
    } else {
      if (/[;&|<>()*?\[\]{}~#]/.test(char)) throw new Error('Git context: use one literal Git command per Bash call; quote pathspecs and use workdir for its directory.');
      value += char; started = true;
    }
  }
  if (quote) throw new Error('Git context: unclosed quote.');
  if (started) args.push(value);
  return args;
}

const flags = new Set(`--short --branch --porcelain --long --verbose --ignored --untracked-files
  --oneline --stat --shortstat --numstat --name-only --name-status --summary --patch --no-patch
  --raw --patch-with-stat --patch-with-raw --full-index --binary --no-color --color
  --no-ext-diff --no-textconv --no-renames --relative --exit-code --quiet --check
  --all --branches --tags --remotes --graph --decorate --no-decorate --reverse --first-parent
  --no-merges --merges --follow --date-order --author-date-order --topo-order --boundary
  --abbrev-commit --no-abbrev-commit --full-history --simplify-by-decoration --left-right
  --cherry-pick --cherry-mark --count --root --no-show-signature
  --cached --stage --others --modified --deleted --unmerged --killed --directory
  --no-empty-directory --exclude-standard --full-name --full-tree --long --recurse-submodules
  --show-toplevel --show-prefix --show-cdup --show-object-format --git-dir --git-common-dir
  --is-inside-work-tree --is-bare-repository --is-shallow-repository --verify --short
  --abbrev-ref --symbolic --symbolic-full-name --end-of-options --not
  -s -b -v -p -u -z -r -t -l -d -m -c -o -k -q -w -b -R -a -C -M
  --ignore-space-at-eol --ignore-cr-at-eol --ignore-blank-lines --ignore-all-space
  --ignore-space-change --no-prefix`.split(/\s+/));
const values = new Set(`--max-count --skip --format --pretty --date --since --until --after --before
  --author --committer --grep --grep-reflog --encoding --diff-filter --unified --abbrev
  --exclude --exclude-from --exclude-per-directory --git-path --prefix --output-object-format
  --src-prefix --dst-prefix --line-prefix --inter-hunk-context -n -S -G -L`.split(/\s+/));
const optionalValues = new Set(`--porcelain --untracked-files --ignored --color --decorate --stat
  --relative --branches --tags --remotes --short --abbrev-ref`.split(/\s+/));
const readCommands = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse']);

function readOperation(command, args) {
  if (command === 'branch' && args.length === 1 && args[0] === '--show-current') return;
  if (!readCommands.has(command)) throw new Error(`Git context: ${command || 'missing operation'} is not an allowed read operation; use the Command Center Git workflow for changes.`);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') continue;
    // Exact flags only: Git accepts abbreviations, including --out for --output.
    const equal = arg.indexOf('=');
    const key = equal < 0 ? arg : arg.slice(0, equal);
    if (equal >= 0 && (values.has(key) || optionalValues.has(key))) continue;
    if (equal < 0 && values.has(arg)) {
      if (++i === args.length || args[i].startsWith('-')) throw new Error(`Git context: use ${arg}=value or a literal value that does not start with '-'.`);
      continue;
    }
    if (equal < 0 && (flags.has(arg) || /^-\d+$/.test(arg) || /^-(?:n|U|M|C)\d+$/.test(arg))) continue;
    throw new Error(`Git context: unsupported read option ${arg}; use its supported full spelling or a simpler read command.`);
  }
}

const shellQuote = value => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

// No "git -C *" permission is introduced. A validated single invocation becomes
// a known read prefix + Bash workdir, then passes through native permissions.
export function normalizeGitContext(args, { directory, readRoots }) {
  if (typeof args.command !== 'string' || !/^\s*git\s+(?:-C\S*|--no-pager)(?:\s|$)/.test(args.command)) return args;
  const argv = literalArgs(args.command.trim());
  const roots = readRoots.map(canonical);
  const resolveDirectory = (base, target) => {
    // Native realpath preserves symlink/.. traversal semantics. path.resolve
    // would collapse .. before following the link and validate a different cwd.
    const resolved = fs.realpathSync.native(path.isAbsolute(target) ? target : `${base}/${target || '.'}`);
    if (!fs.statSync(resolved).isDirectory() || !roots.some(root => inside(root, resolved))) {
      throw new Error(`Git context: directory outside allowed read roots: ${target}`);
    }
    return resolved;
  };
  let cwd = resolveDirectory(directory, args.workdir ?? '.');
  let index = 1;
  while (index < argv.length && argv[index].startsWith('-')) {
    const option = argv[index++];
    if (option === '--no-pager') continue;
    if (option === '-C') {
      if (index === argv.length) throw new Error('Git context: missing directory after -C.');
      cwd = resolveDirectory(cwd, argv[index++]);
    } else if (option.startsWith('-C') && option.length > 2) {
      cwd = resolveDirectory(cwd, option.slice(2));
    } else throw new Error(`Git context: unsupported global option ${option}.`);
  }
  const operation = argv[index++];
  const rest = argv.slice(index);
  readOperation(operation, rest);
  const safety = ['diff', 'log', 'show'].includes(operation) ? ['--no-ext-diff', '--no-textconv'] : [];
  if (['log', 'show'].includes(operation)) safety.push('--no-show-signature');
  return { ...args, workdir: cwd, command: ['git', operation, ...safety, ...rest].map(shellQuote).join(' ') };
}

// Applied only to validated tool calls. User terminals and controller Git writes
// keep their environment. Disable optional index refresh and configured helpers.
export const gitContextEnvironment = Object.freeze({
  GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
});
