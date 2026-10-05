import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setupDockerDemo } from '../setup-docker-demo.mjs';
import { setupDockerProject } from '../setup-docker-project.mjs';
import { prepare, approve, run, status, loadProfile, resume, accept } from '../../core/lib/controller.mjs';
import { previewPublication, publishAccepted } from '../../core/lib/publication.mjs';
import { dockerActivity, dockerExecute, stopDocker } from '../../core/lib/docker.mjs';
import { startRun, stopRun, jobStatus } from '../../core/lib/background.mjs';
import { execute } from '../../core/lib/process.mjs';
import { roleTools } from '../lib/tools.mjs';
import { jsonLines, streams } from '../lib/events.mjs';
import { dockerBadge, dockerDocument, streamText } from '../lib/view.mjs';

const dockerTest = process.env.CC_DOCKER_TEST === '1' ? test : test.skip;
async function setup(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-docker-test-'));
  const f = await setupDockerDemo(path.join(parent, 'fixture'));
  let prepared;
  t.after(async () => {
    if (prepared) { await stopDocker(f.stateDir); await execute(['docker', 'image', 'rm', prepared.snapshot.sandbox.retentionTag], { timeout: 30 }); }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  prepared = await prepare(f.profile, f.task); await approve(f.profile, f.id, prepared.digest);
  return f;
}
async function until(fn) {
  for (let i = 0; i < 500; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out');
}

dockerTest('real pi + Docker: live output, lint repair, Reviewer repair, read-only checks and unchanged source checkout', { timeout: 180000 }, async t => {
  const f = await setup(t);
  const running = run(f.profile, f.id);
  await until(() => streams(f.stateDir).some(x => x.events.some(e => e.type === 'docker_output' && e.text.includes('Builder inside Docker'))));
  assert.match(dockerBadge(f.stateDir), /Docker ● builder/);
  assert.match(streams(f.stateDir).map(streamText).join('\n'), /Builder inside Docker/);
  const done = await running;
  assert.equal(done.status, 'ready_for_user', done.error);
  assert.equal(done.round, 3);
  assert.equal(dockerActivity(f.stateDir).filter(x => x.live).length, 0);
  assert.match(dockerDocument(f.stateDir), /source RO/);
  const commands = jsonLines(path.join(f.stateDir, 'commands.jsonl'));
  assert(commands.some(x => x.kind === 'docker_exec' && x.phase === 'finished' && x.exit_code === 0));
  assert(commands.filter(x => x.kind === 'check').every(x => x.container && x.image));
  assert(jsonLines(path.join(f.stateDir, 'events.jsonl')).some(x => x.type === 'check' && !x.passed));
  assert(streams(f.stateDir).some(x => x.role === 'explorer'));
  assert.equal(fs.readFileSync(path.join(f.base, 'sources/app/value.txt'), 'utf8'), 'original\n');
  await accept(f.profile, f.id, { expectedDigest: done.digest, expectedFingerprint: done.reviewedFingerprint });
  const publication = await previewPublication(f.profile, f.id, { mode: 'commit' });
  const delivered = await publishAccepted(f.profile, f.id, { expectedToken: publication.token, mode: publication.mode, message: publication.message });
  assert.equal(delivered.delivery.status, 'done', delivered.error);
  assert.equal(fs.readFileSync(path.join(f.base, 'sources/app/value.txt'), 'utf8'), 'original\n');
});

dockerTest('Docker tool boundary: virtual paths, symlink escape, Git mask, isolation, read-only roles and timeout cleanup', { timeout: 120000 }, async t => {
  const f = await setup(t), s = status(f.profile, f.id);
  s.status = 'building'; s.round = 1; fs.writeFileSync(path.join(f.stateDir, 'state.json'), JSON.stringify(s));
  const make = role => roleTools({ role, root: f.feature, readRoots: [f.feature], stateDir: f.stateDir, profile: loadProfile(f.profile) });
  const builder = await make('builder'), reader = await make('reviewer');
  const invoke = (tools, name, args) => tools.find(x => x.name === name).execute('test', args);
  assert(!reader.some(x => ['cc_exec', 'cc_write', 'dev_run', 'cc_git'].includes(x.name)));
  assert(!builder.some(x => ['dev_run', 'cc_git'].includes(x.name)));
  await invoke(builder, 'cc_write', { path: '/workspace/app/new.txt', content: 'hello\n' });
  await invoke(builder, 'cc_edit', { path: 'app/new.txt', oldText: 'hello', newText: 'world' });
  assert.match(JSON.stringify(await invoke(reader, 'cc_read', { path: path.join(f.feature, 'app/new.txt') })), /world/);
  fs.symlinkSync(f.commandCenter, path.join(f.feature, 'app/escape'));
  await assert.rejects(invoke(reader, 'cc_read', { path: 'app/escape/AGENTS.md' }), /outside/);
  await assert.rejects(invoke(builder, 'cc_write', { path: '../escape', content: 'bad' }), /outside/);
  await assert.rejects(invoke(builder, 'cc_write', { path: 'app/.git', content: 'bad' }), /metadata/i);
  await invoke(builder, 'cc_exec', { cwd: 'app', argv: ['python', '-c', `import os,pathlib,socket
assert os.getuid() != 0
assert pathlib.Path('.git').read_text() == ''
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path(${JSON.stringify(f.commandCenter)}).exists()
assert not any(k in os.environ for k in ['OPENAI_API_KEY','ZAI_API_KEY','SSH_AUTH_SOCK'])
assert 'CapEff:\\t0000000000000000' in pathlib.Path('/proc/self/status').read_text()
try: pathlib.Path('/etc/cc-probe').write_text('bad'); raise AssertionError('rootfs writable')
except OSError: pass
s=socket.socket(); s.settimeout(.2)
assert s.connect_ex(('1.1.1.1',443)) != 0
pathlib.Path('/build/persist').write_text('ok')
print('isolation passed')`], reason: 'Check sandbox boundaries' });
  const persist = await invoke(builder, 'cc_exec', { cwd: 'app', argv: ['cat', '/build/persist'], reason: 'Persistence' });
  assert.match(JSON.stringify(persist), /ok/);
  const ro = await dockerExecute(s.snapshot, f.stateDir, ['python', '-c', "from pathlib import Path; Path('new.txt').write_text('bad')"], { cwd: 'app', role: 'test', readonly: true });
  assert.notEqual(ro.code, 0);
  const timeout = await dockerExecute(s.snapshot, f.stateDir, ['sh', '-c', 'sleep 60 & wait'], { cwd: 'app', timeout: 1 });
  assert(timeout.timedOut);
  const item = dockerActivity(f.stateDir).find(x => x.status === 'timeout'); assert(item);
  assert.notEqual((await execute(['docker', 'inspect', item.container], { timeout: 10 })).code, 0);
});

dockerTest('stop during Docker execution removes daemon children and resumes saved pi session', { timeout: 180000 }, async t => {
  const f = await setup(t);
  await startRun(f.profile, f.id);
  await until(() => dockerActivity(f.stateDir).some(x => x.live && x.argv.includes('-c')));
  const session = status(f.profile, f.id).builderSession;
  stopRun(f.profile, f.id);
  await until(() => !jobStatus(f.profile, f.id)?.alive);
  assert.equal(status(f.profile, f.id).status, 'paused_interrupted');
  assert.equal(dockerActivity(f.stateDir).filter(x => x.live).length, 0);
  for (const item of dockerActivity(f.stateDir)) assert.notEqual((await execute(['docker', 'inspect', item.container], { timeout: 10 })).code, 0);
  await resume(f.profile, f.id, { acknowledgeUnknown: true });
  const done = await run(f.profile, f.id);
  assert.equal(done.status, 'ready_for_user', done.error);
  assert(streams(f.stateDir).filter(x => x.role === 'builder' && x.events[0].sessionID === session).length >= 2);
});

dockerTest('real-model CSV project starts with green Ruff and frozen acceptance in Docker', { timeout: 60000 }, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-csv-docker-'));
  const f = await setupDockerProject(path.join(parent, 'project'));
  const profile = loadProfile(f.profile), draft = path.join(profile.draftsRoot, 'task.json');
  fs.writeFileSync(path.join(profile.draftsRoot, 'plan.md'), '# Verify unchanged CSV baseline\n\nScope: catalog repository. Preserve read_items and all six records. Run Ruff formatter, lint and both unittest suites inside Docker. No publication.\n');
  fs.writeFileSync(draft, JSON.stringify({ id: 'baseline', source: { kind: 'local' }, plan: 'plan.md', repositories: ['catalog'], acceptance: ['Existing checks pass'] }));
  const s = await prepare(f.profile, draft), dir = path.join(profile.stateRoot, s.id);
  t.after(async () => { await stopDocker(dir); await execute(['docker', 'image', 'rm', s.snapshot.sandbox.retentionTag]); fs.rmSync(parent, { recursive: true, force: true }); });
  assert.equal(s.snapshot.profile.pi.model, 'zai/glm-5.3-flash');
  for (const [phase, commands] of Object.entries(s.snapshot.repos[0].checks)) for (const argv of commands) {
    const result = await dockerExecute(s.snapshot, dir, argv, { cwd: 'catalog', readonly: phase !== 'format', role: phase });
    assert.equal(result.code, 0, result.err);
  }
});
