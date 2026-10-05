import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from '../lib/controller.mjs';
import { git } from '../lib/process.mjs';

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// All repositories and commits are newly authored fixtures, with no remotes.
export async function fixture({ destination, scenario = 'loop', publication = false, maxRounds = 5 } = {}) {
  const root = destination ? path.resolve(destination) : fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cc-demo-'));
  if (destination) fs.mkdirSync(root); // Refuse an existing directory.
  const base = fs.realpathSync(root);
  const commandCenter = path.join(base, 'CommandCenter');
  const drafts = path.join(commandCenter, '.opencode-plans');
  const feature = path.join(base, 'wt', 'demo-feature');
  fs.mkdirSync(drafts, { recursive: true });
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(commandCenter, 'AGENTS.md'), 'Demo: app consumes the library. Change both in the existing feature worktrees.\n');
  const repositories = {};
  for (const id of ['app', 'library']) {
    const source = path.join(base, 'sources', id);
    fs.mkdirSync(source, { recursive: true });
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'OpenCode Example');
    await git(source, 'config', 'user.email', 'example@invalid.test');
    fs.writeFileSync(path.join(source, 'value.txt'), 'original\n');
    fs.writeFileSync(path.join(source, '.gitignore'), 'build/\n');
    await git(source, 'add', '--', 'value.txt', '.gitignore');
    await git(source, 'commit', '-m', 'Create demo fixture');
    await git(source, 'worktree', 'add', '-b', 'demo-feature', path.join(feature, id));
    const commands = phase => [[process.execPath, path.join(CONFIG_DIR, 'demo/check.mjs'), phase]];
    repositories[id] = { source, worktree: id, checks: {
      format: commands('format'), formatCheck: commands('formatCheck'), lint: commands('lint'), test: commands('test'),
    } };
  }
  const profile = path.join(base, 'profile.json');
  writeJSON(profile, { version: 1, enabled: true, commandCenter, worktreeParent: '../wt',
    repositories, maxRounds, timeoutSeconds: 30, knowledge: ['AGENTS.md'],
    opencode: [process.execPath, path.join(CONFIG_DIR, 'demo/mock-opencode.mjs'), scenario],
    hooks: publication ? {
      mergeRequest: [process.execPath, path.join(CONFIG_DIR, 'demo/mock-hook.mjs'), 'mergeRequest'],
      jiraUpdate: [process.execPath, path.join(CONFIG_DIR, 'demo/mock-hook.mjs'), 'jiraUpdate'],
    } : {},
  });
  fs.writeFileSync(path.join(drafts, 'plan.md'), '# Demo plan\n\nUpdate app and library together. Preserve original checkouts. Both values must be valid and the library must satisfy the reviewer.\n');
  const task = path.join(drafts, 'task.json');
  writeJSON(task, { id: 'demo-feature', source: publication ? { kind: 'jira', key: 'DEMO-1' } : { kind: 'local' },
    plan: 'plan.md', repositories: ['app', 'library'], acceptance: ['App and library values pass all checks.'],
    publication: { mergeRequest: publication, jiraUpdate: publication },
  });
  return { base, profile, task, feature, commandCenter, id: 'demo-feature',
    stateDir: path.join(commandCenter, '.opencode-loop-state', 'demo-feature') };
}
