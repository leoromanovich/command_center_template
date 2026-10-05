// Explicit installed-OpenCode integration; all Git repositories are local fixtures.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture, writeJSON } from './fixture.mjs';
import { CONFIG_DIR, parseAgentOutput } from '../lib/controller.mjs';
import { execute, git } from '../lib/process.mjs';

if (!process.argv.includes('--real')) throw new Error('Use --real --profile <configured profile>');
const at = process.argv.indexOf('--profile');
assert(at >= 0, 'A configured profile is required');
const configured = JSON.parse(fs.readFileSync(path.resolve(process.argv[at + 1])));
const f = await fixture({ scenario: 'pass' });
const profile = JSON.parse(fs.readFileSync(f.profile));
Object.assign(profile, { opencode: configured.opencode, models: configured.models, disabledMcp: configured.disabledMcp });
writeJSON(f.profile, profile);
const repo = path.join(f.feature, 'app space');
await git(profile.repositories.app.source, 'worktree', 'move', path.join(f.feature, 'app'), repo);
const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
const marker = path.join(f.base, 'helper-ran'), helper = path.join(f.base, 'helper');
fs.writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
await git(repo, 'config', 'core.fsmonitor', helper);
fs.appendFileSync(path.join(repo, 'value.txt'), 'Native Git read guard test.\n');
const before = { head: await git(repo, 'rev-parse', 'HEAD'), refs: await git(repo, 'show-ref'), file: fs.readFileSync(path.join(repo, 'value.txt'), 'utf8') };
const commands = [
  { command: `git -C "${repo}" --no-pager log --oneline -3`, status: 'completed' },
  { command: `git --no-pager -C "${repo}" show HEAD --stat --oneline`, status: 'completed' },
  { command: `git -C "${repo}" status --short`, status: 'completed' },
  { command: `git -C "${repo}" branch should-not-exist`, status: 'rejected' },
  { command: `git -C "${outside}" log --oneline -1`, status: 'rejected' },
];
fs.writeFileSync(path.join(f.commandCenter, 'AGENTS.md'), 'Synthetic Git permission test. Follow the supplied test calls exactly, then stop.\n');
const log = path.join(f.base, 'native-git-context.log');
console.log(JSON.stringify({ fixture: f.base, log }));
const model = profile.models.builder;
const result = await execute([...profile.opencode, 'run', '--dir', f.commandCenter, '--agent', 'planner', '--model', model, '--format', 'json'], {
  cwd: f.commandCenter, timeout: 180, log,
  env: { OPENCODE_CONFIG_DIR: CONFIG_DIR, CC_PROFILE: f.profile, CC_WORKER_ROLE: '', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: 'planner', share: 'disabled', small_model: model,
      agent: { planner: { reasoningEffort: 'low' } }, mcp: Object.fromEntries((profile.disabledMcp ?? []).map(x => [x, { enabled: false }])) }) },
  input: `Run this bounded integration test in the synthetic repositories explicitly provided by the user. Call Bash once for EACH of these five exact command strings (separate tool calls, default workdir, no wrappers):\n${commands.map(x => x.command).join('\n')}\nThe first three should succeed. The fourth and fifth deliberately test refusals by our plugin; submit them unchanged once, even though the guard should reject them. There are no remotes or user repositories. Do not retry blocked commands, bypass guards, call any other tools, edit files or start the feature pipeline. After all five calls briefly report observed success/refusals.`,
});
assert.equal(result.code, 0, result.err); assert.equal(result.timedOut, false);
parseAgentOutput(result.out);
const journal = path.join(f.commandCenter, '.opencode-loop-state', 'commands.jsonl');
const finished = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.phase === 'finished');
for (const expected of commands) {
  const found = finished.filter(x => (x.requested_command ?? x.command) === expected.command);
  assert.equal(found.length, 1, `Missing/duplicate tool call: ${expected.command}`);
  assert.equal(found[0].status, expected.status, found[0].error);
  if (expected.status === 'completed') {
    assert.equal(found[0].exit_code, 0);
    assert.equal(found[0].cwd, repo);
    assert.notEqual(found[0].command, expected.command);
  }
}
assert.equal(await git(repo, 'rev-parse', 'HEAD'), before.head);
assert.equal(await git(repo, 'show-ref'), before.refs);
assert.equal(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8'), before.file);
assert(!fs.existsSync(marker), 'Configured fsmonitor was executed');
writeJSON(path.join(f.base, 'git-context-result.json'), { passed: true, model, fixture: f.base, calls: finished.map(x => ({ status: x.status, requested: x.requested_command ?? x.command, command: x.command, cwd: x.cwd, exit: x.exit_code, error: x.error })), headUnchanged: true, refsUnchanged: true, filesUnchanged: true, helperExecuted: false });
console.log(JSON.stringify({ passed: true, report: path.join(f.base, 'git-context-result.json') }));
