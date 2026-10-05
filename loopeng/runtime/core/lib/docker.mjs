import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execute } from './process.mjs';
import { canonical, inside } from './policy.mjs';
import { atomicJSON, identity, alive } from './recovery.mjs';

const helper = fileURLToPath(new URL('./docker-files.py', import.meta.url));
const owner = dir => crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24);
const label = dir => `cc.pi.sandbox=${owner(dir)}`;
const must = (ok, message) => { if (!ok) throw new Error(message); };
const now = () => new Date().toISOString();
async function docker(args) {
  const result = await execute(['docker', ...args], { timeout: 30 });
  must(result.code === 0 && !result.timedOut && !result.limited, result.err || 'Docker is unavailable');
  return result.out.trim();
}

// Resolve image and context BEFORE plan approval. A retention tag protects Docker
// Desktop's containerd image index when the project's mutable tag is rebuilt.
export async function prepareDocker(profile, taskID) {
  if (!profile.sandbox) return undefined;
  const spec = profile.sandbox;
  must(spec.kind === 'docker' && profile.agentRuntime?.kind === 'pi', 'Docker sandbox requires the pi runtime');
  must(!profile.devRun.enabled, 'Docker uses cc_exec; set devRun.enabled=false');
  must(typeof spec.image === 'string' && spec.image.length > 0 && !spec.image.startsWith('-'), 'sandbox.image is required');
  const info = JSON.parse(await docker(['image', 'inspect', spec.image]))[0];
  must(info?.Os === 'linux' && /^sha256:[a-f0-9]{64}$/.test(info.Id), 'Expected a local Linux image');
  const uid = process.getuid?.(), gid = process.getgid?.();
  must(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid), 'Launch pi as a non-root user');
  const retentionTag = `local/cc-pi-${owner(path.join(profile.stateRoot, taskID))}:${info.Id.slice(7, 23)}`;
  await docker(['image', 'tag', info.Id, retentionTag]);
  const context = [];
  for (const name of spec.contextFiles ?? []) {
    must(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) && !name.split('/').some(x => x === '..' || x.startsWith('.')), 'Context files must be explicit relative non-hidden paths');
    const file = canonical(path.resolve(profile.commandCenter, name));
    must(inside(profile.commandCenter, file) && fs.statSync(file).isFile() && fs.statSync(file).size <= 2 * 1024 * 1024, 'Invalid Docker context file');
    context.push({ name, content: fs.readFileSync(file, 'utf8') });
  }
  return { kind: 'docker', image: spec.image, imageID: info.Id, retentionTag, uid, gid, context, network: 'none' };
}

export function containerPath(snapshot, value = '.') {
  must(typeof value === 'string' && !value.includes('\0'), 'Expected a literal path');
  if (value === '/knowledge' || value.startsWith('/knowledge/')) {
    const resolved = path.posix.resolve(value);
    must(snapshot.knowledgeBase && (resolved === '/knowledge' || resolved.startsWith('/knowledge/')), 'Path escapes knowledge');
    return resolved;
  }
  if (value === '/context' || value.startsWith('/context/')) {
    const resolved = path.posix.resolve(value);
    must(resolved === '/context' || resolved.startsWith('/context/'), 'Path escapes context');
    return resolved;
  }
  const virtual = value === '/workspace' || value.startsWith('/workspace/');
  const host = virtual ? path.resolve(snapshot.featureRoot, path.posix.relative('/workspace', path.posix.resolve(value))) : path.resolve(snapshot.featureRoot, value);
  must(inside(snapshot.featureRoot, host), 'Path outside the feature');
  return '/workspace' + (host === snapshot.featureRoot ? '' : '/' + path.relative(snapshot.featureRoot, host));
}

function mount(source, target, readonly = false) {
  must(![source, target].some(x => /[,\n\r\0]/.test(x)), 'Unsupported mount path');
  return ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`];
}

export function dockerActivity(dir) {
  const folder = path.join(dir, 'docker-activity');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(x => x.endsWith('.json')).map(x => {
    try { const record = JSON.parse(fs.readFileSync(path.join(folder, x))); return { ...record, live: record.status === 'running' && alive(record.owner) }; } catch { return undefined; }
  }).filter(Boolean).sort((a, b) => b.started.localeCompare(a.started));
}

// Call only after the controller has established exclusive task ownership.
export async function stopDocker(dir) {
  const ids = (await docker(['ps', '-aq', '--filter', `label=${label(dir)}`])).split(/\s+/).filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]);
  for (const record of dockerActivity(dir).filter(x => x.status === 'running')) {
    delete record.live;
    atomicJSON(path.join(dir, 'docker-activity', `${record.id}.json`), { ...record, status: 'interrupted', ended: now() });
  }
}

export async function dockerExecute(snapshot, dir, argv, options = {}) {
  const { role = 'builder', readonly = false, storage = role, emit = () => {}, ...execution } = options;
  must(snapshot.sandbox?.kind === 'docker', 'Approved Docker sandbox is required');
  must(Array.isArray(argv) && argv.length && argv.every(x => typeof x === 'string' && !x.includes('\0')), 'Use a literal argv array');
  must(/^[a-zA-Z0-9_-]+$/.test(storage), 'Invalid sandbox storage key');
  const sandbox = snapshot.sandbox, id = crypto.randomUUID(), name = `cc-pi-${owner(dir)}-${id}`;
  const base = path.join(dir, 'docker'), work = path.join(base, storage), context = path.join(base, 'context');
  for (const folder of [context, path.join(work, 'home'), path.join(work, 'build'), path.join(base, 'empty-git-dir')]) fs.mkdirSync(folder, { recursive: true });
  const gitFile = path.join(base, 'empty-git-file'); fs.writeFileSync(gitFile, '');
  for (const file of sandbox.context) {
    const target = path.join(context, file.name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content);
  }
  const cwd = containerPath(snapshot, execution.cwd ?? snapshot.featureRoot);
  const args = ['docker', 'run', '--name', name, '--rm', '--init', '--pull=never', '--label', label(dir), '--label', `cc.pi.role=${role}`,
    '--network=none', '--ipc=private', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--user', `${sandbox.uid}:${sandbox.gid}`,
    '--workdir', cwd, '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--env', 'HOME=/home/agent', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PYTHONUNBUFFERED=1', '--env', 'RUFF_NO_CACHE=true'];
  for (const repo of snapshot.repos) {
    must(canonical(repo.root) === repo.root && inside(snapshot.featureRoot, repo.root) && repo.root !== snapshot.featureRoot, 'Repository mount changed');
    const target = containerPath(snapshot, repo.root), dotgit = path.join(repo.root, '.git');
    const stat = fs.lstatSync(dotgit);
    must(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Invalid Git metadata mount');
    args.push(...mount(repo.root, target, readonly || !!snapshot.knowledgeUpdate), ...mount(stat.isDirectory() ? path.join(base, 'empty-git-dir') : gitFile, `${target}/.git`, true));
  }
  if (snapshot.knowledgeBase) {
    const kb = snapshot.knowledgeBase;
    must(canonical(kb.root) === kb.root && fs.statSync(kb.root).isDirectory(), 'Knowledge mount changed');
    args.push(...mount(kb.root, '/knowledge', true), ...mount(gitFile, '/knowledge/.git', true));
    if (snapshot.knowledgeUpdate) {
      args.push('--env', 'CC_STAGE=knowledge');
      if (role === 'builder' && !readonly) {
        for (const name of kb.writablePaths) {
          const folder = path.join(kb.root, name);
          must(inside(kb.root, folder) && folder !== kb.root && canonical(folder) === folder && fs.statSync(folder).isDirectory(), 'Knowledge write mount changed');
          args.push(...mount(folder, '/knowledge/' + name));
        }
        args.push('--env', 'CC_KNOWLEDGE_WRITES=' + JSON.stringify(snapshot.knowledgeUpdate.paths));
      }
    }
  }
  args.push(...mount(context, '/context', true), ...mount(helper, '/cc-tools/files.py', true), ...mount(path.join(work, 'home'), '/home/agent'), ...mount(path.join(work, 'build'), '/build'));
  if (execution.input !== undefined) args.push('-i');
  args.push(`--entrypoint=${argv[0]}`, sandbox.imageID, ...argv.slice(1));
  const file = path.join(dir, 'docker-activity', `${id}.json`);
  let record = { id, container: name, image: sandbox.imageID, role, argv, cwd, readonly: readonly || !!snapshot.knowledgeUpdate,
    ...(snapshot.knowledgeUpdate ? { knowledgeWritable: role === 'builder' && !readonly } : {}), status: 'running', started: now(), owner: identity() };
  atomicJSON(file, record); emit({ type: 'docker_started', ...record });
  try {
    const result = await execute(args, { ...execution, cwd: dir, maxOutputBytes: execution.maxOutputBytes ?? 2 * 1024 * 1024,
      audit: { ...execution.audit, container: name, image: sandbox.imageID, container_argv: argv, container_cwd: cwd, command: argv.map(x => "'" + x.replaceAll("'", "'\\''") + "'").join(' ') },
      onOutput(chunk, stderr) { execution.onOutput?.(chunk, stderr); emit({ type: 'docker_output', id, text: chunk, stderr }); } });
    record = { ...record, status: result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : result.limited ? 'output_limit' : result.code === 0 ? 'finished' : 'failed', code: result.code };
    return result;
  } catch (error) { record = { ...record, status: 'failed', error: error.message }; throw error; }
  finally {
    // Killing docker CLI does not kill daemon-side descendants.
    const removed = await execute(['docker', 'rm', '-f', name], { timeout: 30 });
    if (removed.code !== 0 && !/No such container/.test(removed.err)) {
      record = { ...record, status: 'cleanup_failed', error: removed.err };
      atomicJSON(file, { ...record, ended: now() });
      throw new Error(`Docker cleanup failed for ${name}: ${removed.err}`);
    }
    atomicJSON(file, { ...record, ended: now() }); emit({ type: 'docker_finished', ...record });
  }
}
