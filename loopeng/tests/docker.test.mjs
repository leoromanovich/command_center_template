import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { templateFixture } from './fixture.mjs';
import { initExample } from '../scripts/cc.mjs';
import { prepare } from '../runtime/core/lib/controller.mjs';
import { dockerExecute, stopDocker } from '../runtime/core/lib/docker.mjs';
import { execute } from '../runtime/core/lib/process.mjs';

const dockerTest = process.env.CC_DOCKER_TEST === '1' ? test : test.skip;
dockerTest('separate CSV CC prepares worktree and passes Ruff/unittest without changing working CC', { timeout: 90000 }, async t => {
  const f = templateFixture(t), profile = await initExample(f.root), drafts = profile.draftsRoot;
  fs.writeFileSync(path.join(drafts, 'plan.md'), '# Verify template baseline\n\nPreserve catalog API and six CSV items. Run the configured formatter, lint, worktree tests and frozen acceptance checks. No publication.\n');
  const task = path.join(drafts, 'task.json');
  fs.writeFileSync(task, JSON.stringify({ id: 'portable-baseline', source: { kind: 'local' }, plan: 'plan.md', repositories: ['catalog'], acceptance: ['All baseline checks pass'] }));
  const state = await prepare(profile.filename, task), dir = path.join(profile.stateRoot, state.id);
  try {
    assert.equal(state.snapshot.featureRoot, path.join(profile.commandCenter, 'wt/portable-baseline'));
    assert.equal(state.snapshot.profile.agentRuntime.command[1], path.join(f.root, 'runtime/pi/worker.mjs'));
    assert(!fs.existsSync(f.profile.worktreeParent));
    assert.deepEqual(f.profile.repositories, {});
    assert(state.snapshot.knowledge.every(x => x.path.startsWith(profile.commandCenter + path.sep)));
    for (const [phase, commands] of Object.entries(state.snapshot.repos[0].checks)) {
      for (const argv of commands) {
        const result = await dockerExecute(state.snapshot, dir, argv, { cwd: 'catalog', role: phase, readonly: phase !== 'format' });
        assert.equal(result.code, 0, `${phase}: ${result.err}\n${result.out}`);
      }
    }
  } finally {
    await stopDocker(dir);
    await execute(['docker', 'image', 'rm', state.snapshot.sandbox.retentionTag]);
  }
});
