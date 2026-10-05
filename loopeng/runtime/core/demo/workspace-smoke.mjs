// Explicit native Planner smoke. All repositories are newly authored local fixtures.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture, writeJSON } from './fixture.mjs';
import { CONFIG_DIR, status, parseAgentOutput } from '../lib/controller.mjs';
import { git, execute } from '../lib/process.mjs';

if (!process.argv.includes('--real')) throw new Error('Use --real --profile <configured profile>');
const at = process.argv.indexOf('--profile');
assert(at >= 0, 'A configured profile is required');
const configured = JSON.parse(fs.readFileSync(path.resolve(process.argv[at + 1])));
const f = await fixture({ scenario: 'pass' }), p = JSON.parse(fs.readFileSync(f.profile));
for (const [id, repo] of Object.entries(p.repositories)) {
  await git(repo.source, 'worktree', 'remove', path.join(f.feature, id));
  await git(repo.source, 'branch', '-d', f.id);
  repo.baseRef = 'main';
}
await git(f.commandCenter, 'init', '-b', 'main');
Object.assign(p, { workspace: { autoCreate: true }, worktreeParent: 'WorkTree', git: { allowCommit: true, allowPush: false },
  opencode: configured.opencode, models: configured.models, disabledMcp: configured.disabledMcp });
writeJSON(f.profile, p);
const task = JSON.parse(fs.readFileSync(f.task));
task.worktrees = Object.fromEntries(task.repositories.map(id => [id, { base: 'main', branch: `feature/${f.id}` }]));
task.publication = { commit: true, push: false }; writeJSON(f.task, task);
fs.writeFileSync(path.join(f.commandCenter, 'AGENTS.md'), 'Local synthetic preparation test. Use cc_prepare to create the explicitly selected feature worktrees. Do not implement or approve the plan.\n');
const log = path.join(f.base, 'native-planner.log');
console.log(JSON.stringify({ fixture: f.base, log, stateDir: f.stateDir }));
const model = p.models.builder;
const result = await execute([...p.opencode, 'run', '--dir', f.commandCenter, '--agent', 'planner', '--model', model, '--format', 'json'], {
  cwd: f.commandCenter, timeout: 180, log,
  env: { OPENCODE_CONFIG_DIR: CONFIG_DIR, CC_PROFILE: f.profile, CC_WORKER_ROLE: '', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: 'planner', share: 'disabled', small_model: model,
      agent: { planner: { reasoningEffort: 'low' } }, mcp: Object.fromEntries((p.disabledMcp ?? []).map(x => [x, { enabled: false }])) }) },
  input: `The user authorizes preparing the existing synthetic task, with main as the base and feature/${f.id} as the new branch in both repositories. The plan and all choices are already written in ${f.task}. Call cc_prepare with that exact absolute task_path. This tool should automatically create both missing worktrees. Then report the actual result briefly. Do not ask the user to create worktrees, edit files, approve the task or start Builder. This is a preparation-only test.`,
});
assert.equal(result.code, 0, result.err); assert.equal(result.timedOut, false);
parseAgentOutput(result.out);
const s = status(f.profile, f.id); assert.equal(s.status, 'prepared');
assert.equal(s.snapshot.repos.length, 2);
for (const repo of s.snapshot.repos) {
  assert.equal(repo.branch, `feature/${f.id}`);
  await git(f.commandCenter, 'check-ignore', '--', path.relative(f.commandCenter, path.join(repo.root, 'value.txt')));
}
writeJSON(path.join(f.base, 'smoke-result.json'), { passed: true, model, status: s.status, repositories: s.snapshot.repos.map(r => ({ id: r.id, root: r.root, branch: r.branch })), fixture: f.base });
console.log(JSON.stringify({ passed: true, report: path.join(f.base, 'smoke-result.json') }));
