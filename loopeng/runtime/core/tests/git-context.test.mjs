import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeGitContext, gitContextEnvironment } from '../lib/git-context.mjs';
import { contextBash, rolePermission } from '../lib/policy.mjs';
import { bashAuditor } from '../lib/bash-audit.mjs';
import { execute, git } from '../lib/process.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function setup(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-context-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const center = path.join(base, 'center'), repo = path.join(center, "repo's space"), outside = path.join(base, 'outside');
  for (const dir of [center, repo, outside]) fs.mkdirSync(dir, { recursive: true });
  const options = { directory: center, readRoots: [center] };
  const normalize = (command, workdir) => normalizeGitContext({ command, ...(workdir ? { workdir } : {}), description: 'test', timeout: 3000 }, options);
  return { base, center, repo, outside, options, normalize };
}
// OpenCode's native permission reducer checks each command against ordered glob
// rules. Integration below also exercises the installed OpenCode separately.
function permission(command) {
  let action;
  for (const [pattern, candidate] of Object.entries(contextBash())) {
    const regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    if (new RegExp(`^${regex}$`, 's').test(command)) action = candidate;
  }
  return action;
}

test('real failed Planner log/show forms normalize into existing read permissions', t => {
  const f = setup(t);
  for (const operation of ['log --oneline -3', 'show HEAD --stat --oneline', 'status --short', 'branch --show-current', 'ls-tree -r HEAD', 'ls-files', 'rev-parse --show-toplevel', 'diff --stat']) {
    const args = f.normalize(`git -C ${quote(f.repo)} --no-pager ${operation}`);
    assert.equal(args.workdir, f.repo);
    assert.equal(args.timeout, 3000);
    assert.equal(permission(args.command), 'allow', args.command);
    assert(!args.command.includes('--no-pager'));
  }
  assert.equal(permission(`git -C ${quote(f.repo)} log --oneline`), 'deny');
  assert.equal(permission('git --no-pager log --oneline'), 'deny');
});

test('relative, attached, repeated -C and either global flag order preserve directory semantics', t => {
  const f = setup(t);
  const relative = path.basename(f.repo);
  for (const command of [
    `git --no-pager -C ${quote(relative)} log -1`,
    `git -C${quote(relative)} -C '' -C . log -1`,
    `git -C . -C ${quote(relative)} --no-pager --no-pager log -1`,
    'git --no-pager log -1',
  ]) assert.equal(f.normalize(command, command === 'git --no-pager log -1' ? f.repo : f.center).workdir, f.repo);
  assert.throws(() => f.normalize('git -C missing -C .. log'), /ENOENT/);
});

test('reject outside roots, sibling-prefix paths, symlink escapes, and physical symlink/.. escapes', t => {
  const f = setup(t);
  const sibling = `${f.center}-other`;
  fs.mkdirSync(sibling);
  fs.mkdirSync(path.join(f.outside, 'child'));
  fs.symlinkSync(path.join(f.outside, 'child'), path.join(f.center, 'escape'));
  fs.symlinkSync(f.outside, path.join(f.center, 'link'));
  fs.symlinkSync(path.join(f.outside, 'missing'), path.join(f.center, 'dangling'));
  for (const target of [f.outside, sibling, '../outside', 'link', 'escape/..', 'dangling', 'missing']) {
    assert.throws(() => f.normalize(`git -C ${quote(target)} log`), /outside|ENOENT/, target);
  }
  assert.throws(() => f.normalize(`git -C ${quote(f.repo)} log`, f.outside), /outside/);
  assert.throws(() => normalizeGitContext({ command: 'git -C . log' }, { directory: f.center, readRoots: [] }), /outside/);
});

test('all Git writes, aliases, extra branch operations and global config/directory overrides fail closed', t => {
  const f = setup(t);
  for (const operation of ['add .', 'commit -m x', 'push', 'reset --hard', 'clean -fd', 'checkout main', 'switch main', 'fetch', 'pull', 'clone a b', 'config x y', 'worktree add x', 'branch new', 'branch --show-current -D main', 'alias-name']) {
    assert.throws(() => f.normalize(`git -C . ${operation}`), /not an allowed read/);
  }
  for (const option of ['-c core.pager=anything', '--config-env=core.pager=ANYTHING', '--git-dir=/tmp', '--work-tree=/tmp', '--exec-path=/tmp', '--paginate', '--bare']) {
    assert.throws(() => f.normalize(`git -C . ${option} log`), /unsupported global/);
  }
  assert.throws(() => f.normalize('git -C'), /missing directory/);
  assert.throws(() => f.normalize('git -C .'), /missing operation/);
});

test('output, helpers, option abbreviations and misleading value options cannot escape validation', t => {
  const f = setup(t);
  for (const option of ['--output=result', '--output result', '--out=result', '--o=result', '--ext-diff', '--ext', '--textconv', '--text', '--no-index', '--show-signature', '--pretty --output=result', '--format --output=result', '--abbrev --out=result']) {
    assert.throws(() => f.normalize(`git --no-pager -C . log ${option}`), /unsupported read|literal value/, option);
  }
  assert.equal(permission(f.normalize('git -C . log --format="%h %s" --max-count=3').command), 'allow');
});

test('shell chains, redirects, substitutions, environment, glob expansion and controls do not get rewritten', t => {
  const f = setup(t);
  for (const suffix of ['; git reset --hard', ' && git commit -m x', ' | head', ' > result', ' 2> result', ' $(touch result)', ' `touch result`', '\nls', '\t--oneline', ' *', ' # comment', ' &']) {
    assert.throws(() => f.normalize(`git -C . log${suffix}`), /Git context/, suffix);
  }
  for (const command of ['git -C "$PWD" log', 'git -C ~/repo log', 'git -C . log "unfinished', 'git -C . log \\', 'git --no-pager\tlog']) assert.throws(() => f.normalize(command), /Git context/);
  for (const command of ['git -c core.pager=x log', 'GIT_DIR=/tmp git -C . log', 'env git -C . log', 'git --paginate log']) {
    const original = { command };
    assert.equal(normalizeGitContext(original, f.options), original);
    assert.equal(permission(command), 'deny');
  }
});

test('unrelated context Bash and existing Git commands retain their permissions', t => {
  const f = setup(t);
  for (const command of ['ls -l | head', 'rg "git -C" .', 'git log --oneline -3', 'git status', 'git diff --stat']) {
    const args = { command };
    assert.equal(normalizeGitContext(args, f.options), args);
  }
  for (const role of ['planner', 'orchestrator', 'builder', 'reviewer']) assert.equal(rolePermission(role).bash['git -C *'], undefined);
  assert.equal(rolePermission('execution-reviewer').bash, undefined);
});

test('real Git executes literal quoted argv in the chosen repo and disables configured read helpers', async t => {
  const f = setup(t);
  await git(f.repo, 'init', '-b', 'main');
  await git(f.repo, 'config', 'user.name', 'Test');
  await git(f.repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(f.repo, 'value.txt'), 'original\n');
  await git(f.repo, 'add', 'value.txt');
  await git(f.repo, 'commit', '-m', 'Literal test');
  const marker = path.join(f.base, 'helper-ran');
  const helper = path.join(f.base, 'helper');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf ran > ${quote(marker)}\n`, { mode: 0o700 });
  for (const [key, value] of [['core.fsmonitor', helper], ['core.pager', helper], ['diff.external', helper], ['diff.guard.textconv', helper], ['log.showSignature', 'true'], ['gpg.program', helper]]) await git(f.repo, 'config', key, value);
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), '*.txt diff=guard\n');
  fs.writeFileSync(path.join(f.repo, 'value.txt'), 'modified\n');
  const index = fs.readFileSync(path.join(f.repo, '.git/index'));
  for (const operation of ["log --format='%h %s' -1", 'show HEAD --stat --oneline', 'diff', 'status --short', 'branch --show-current', 'rev-parse --show-toplevel']) {
    const args = f.normalize(`git -C ${quote(f.repo)} --no-pager ${operation}`);
    const result = await execute(['/bin/sh', '-c', args.command], { cwd: args.workdir, env: gitContextEnvironment });
    assert.equal(result.code, 0, `${operation}: ${result.err}`);
    if (operation.startsWith('log')) assert.match(result.out, /Literal test/);
    if (operation === 'diff') assert.match(result.out, /modified/);
    if (operation === 'branch --show-current') assert.equal(result.out.trim(), 'main');
    if (operation.startsWith('rev-parse')) assert.equal(result.out.trim(), f.repo);
  }
  assert(!fs.existsSync(marker));
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git/index')), index);
  const literal = "literal $HOME `echo BAD` ' quote";
  const args = f.normalize(`git -C ${quote(f.repo)} log --format=${quote(`format:${literal}`)} -1`);
  const result = await execute(['/bin/sh', '-c', args.command], { cwd: args.workdir, env: gitContextEnvironment });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim(), literal);
});

test('command audit retains requested command and records effective cwd/command and rejection once', t => {
  const f = setup(t), audit = bashAuditor({ root: path.join(f.base, 'audit'), cwd: f.center });
  const input = { tool: 'bash', sessionID: 'test', callID: '1' };
  const requested = { command: `git -C ${quote(f.repo)} --no-pager log -1` };
  const effective = normalizeGitContext(requested, f.options);
  audit.before(input, effective, 'planner', requested);
  audit.started({ ...input, cwd: effective.workdir });
  audit.finish(input, { metadata: { exit: 0 } });
  audit.before({ ...input, callID: '2' }, { command: 'git -C . reset --hard' }, 'planner');
  audit.finish({ ...input, callID: '2' }, undefined, 'not an allowed read operation');
  audit.finish({ ...input, callID: '2' }, undefined, 'duplicate native error event');
  const lines = fs.readFileSync(path.join(f.base, 'audit/commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 5);
  assert.equal(lines[2].command, effective.command);
  assert.equal(lines[2].cwd, f.repo);
  assert.equal(lines[2].requested_command, requested.command);
  assert.equal(lines[4].status, 'rejected');
});
