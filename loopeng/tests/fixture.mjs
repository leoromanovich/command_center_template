import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, materializeProfile } from '../scripts/cc.mjs';

export function templateFixture(t, { configured = false } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-template-')));
  const root = path.join(parent, "CC moved ' with spaces");
  const excluded = new Set(['.git', '.local', '.pi', 'WorkTree', 'node_modules', 'graphify-out', '.demo', '.docker-demo', '.docker-project', '.knowledge-project', 'cc.local.json']);
  fs.cpSync(ROOT, root, { recursive: true, filter: file => !path.relative(ROOT, file).split(path.sep).some(part => excluded.has(part)) });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let source;
  if (configured) {
    source = path.join(parent, 'service'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# User service fixture\n');
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@invalid.test'], ['add', '.'], ['commit', '-m', 'Seed fixture']]) {
      const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: source, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    fs.writeFileSync(path.join(root, 'cc.local.json'), JSON.stringify({ repositories: { service: { source, worktree: 'service', baseRef: 'main',
      checks: Object.fromEntries(['format', 'formatCheck', 'lint', 'test'].map(phase => [phase, [['python', '-c', 'print("fixture check")']]])) } } }));
  }
  return { root, source, profile: materializeProfile(root) };
}
