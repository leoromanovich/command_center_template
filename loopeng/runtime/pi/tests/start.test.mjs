import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseStartArgs, sessionArgs, resumeCommand } from '../start.mjs';
import { ROOT } from '../lib/pi.mjs';

test('launcher preserves the selected profile and explicit session without implicitly resuming new tasks', () => {
  const options = parseStartArgs(['--profile', '/a b/profile.json', '--session', '01a0ae3b-28cd-7784-90ad-e17a4bfb35b0']);
  assert.equal(options.profile, '/a b/profile.json');
  assert.deepEqual(sessionArgs(options), ['--session', '01a0ae3b-28cd-7784-90ad-e17a4bfb35b0']);
  assert.deepEqual(sessionArgs(parseStartArgs(['--demo', '--resume'])), ['--resume']);
  assert.deepEqual(sessionArgs(parseStartArgs(['--demo'])), []);
  assert.equal(parseStartArgs(['--docker-demo', '--resume'])['docker-demo'], true);
  assert.throws(() => parseStartArgs(['--docker-demo', '--demo']));
  assert.throws(() => parseStartArgs(['--docker-demo', '--profile', '/profile']));
  for (const args of [['--profile'], ['--profile', '--resume'], ['--session'], ['--resume', '--session', 'id'], ['--demo', '--profile', '/p'], ['--demoo'], ['--demo', '--demo']]) {
    assert.throws(() => parseStartArgs(args));
  }
});

test('resume hint invokes the adapter and shell-quotes a profile path', () => {
  const profile = "/a b/it's $literal/profile.json";
  const hint = resumeCommand({}, profile);
  const result = spawnSync('/bin/sh', ['-c', `set -- ${hint}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [`${ROOT}/start`, '--profile', profile, '--resume']);
  assert.match(resumeCommand({ demo: true }, profile), /'--demo' '--resume'$/);
  assert.match(resumeCommand({ 'docker-demo': true }, profile), /'--docker-demo' '--resume'$/);
});
