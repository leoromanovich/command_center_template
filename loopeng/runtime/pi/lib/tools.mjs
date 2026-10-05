import fs from 'node:fs';
import { proposeKnowledge, knowledgeWorkerState } from '../../core/lib/knowledge.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, inside, writablePath } from '../../core/lib/policy.mjs';
import { normalizeGitContext, gitContextEnvironment } from '../../core/lib/git-context.mjs';
import { execute } from '../../core/lib/process.mjs';
import { parseReview, prepare, reviewExecution } from '../../core/lib/controller.mjs';
import { runDevCommand, parseExecutionReview } from '../../core/lib/dev-run.mjs';
import { requestUserAction, assertNoPendingUserAction } from '../../core/lib/user-actions.mjs';
import { loadPi } from './pi.mjs';
import { dockerExecute, containerPath } from '../../core/lib/docker.mjs';

export const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const string = { type: 'string', minLength: 1 };
export const textResult = text => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }] });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function readPath(target, { root, readRoots }) {
  if (typeof target !== 'string' || target.includes('\0')) throw new Error('A literal path is required');
  const resolved = fs.realpathSync.native(path.isAbsolute(target) ? target : `${root}/${target}`);
  if (!readRoots.some(r => inside(canonical(r), resolved))) throw new Error('Read outside allowed roots');
  if (path.basename(resolved).match(/^\.env(?:\.|$)/) && !resolved.endsWith('.env.example')) throw new Error('Environment secrets are unavailable to this role');
  return resolved;
}

export async function roleTools(options) {
  const { sdk } = await loadPi();
  const { role, root, readRoots, stateDir, profile, emit = () => {}, sessionID = () => '', explore } = options;
  const scope = { root, readRoots };
  const state = () => options.knowledgeStage ? knowledgeWorkerState(stateDir) : JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json')));
  const snapshot = role !== 'planner' && stateDir ? state().snapshot : undefined;
  const sandbox = snapshot?.sandbox;
  const containerRun = async (argv, c, { cwd = root, input, readonly = role !== 'builder', kind = 'docker_tool' } = {}) => {
    const result = await dockerExecute(snapshot, stateDir, argv, { role, cwd, input, readonly, signal: c.signal, emit, detached: false,
      timeout: Math.min(profile.timeoutSeconds, 900), log: path.join(stateDir, 'docker-logs', `${crypto.randomUUID()}.log`),
      onOutput: chunk => { if (kind === 'docker_exec') c.onUpdate?.(textResult(chunk)); },
      audit: { root: profile.stateRoot, stateDir, actor: role, kind, feature: state().id, round: state().round } });
    if (result.code !== 0 || result.timedOut || result.limited || result.cancelled) throw new Error(`Docker command ${result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : `exit ${result.code}`}: ${result.err || result.out}`);
    return textResult(result.out + result.err);
  };
  const tool = (name, description, parameters, fn) => ({ name, label: name, description, parameters,
    async execute(id, args, signal, onUpdate) {
      // Final executor boundary, after all hooks and argument mutations.
      if (role === 'builder') {
        const s = state();
        if (!options.knowledgeStage) {
          if (s.status !== 'building' || s.approved?.digest !== s.digest || crypto.createHash('sha256').update(JSON.stringify(s.snapshot)).digest('hex') !== s.digest) throw new Error('Builder needs the current approved snapshot');
          if (name !== 'request_user_action') assertNoPendingUserAction(stateDir);
        }
      }
      emit({ type: 'tool', name, id, args });
      if (sandbox && ['cc_read', 'cc_ls', 'cc_find', 'cc_grep', 'cc_write', 'cc_edit'].includes(name)) {
        return containerRun(['python', '-I', '-B', '/cc-tools/files.py'], { id, signal, onUpdate }, {
          readonly: !['cc_write', 'cc_edit'].includes(name), input: JSON.stringify({ tool: name, args: { ...args, path: containerPath(snapshot, args.path ?? '.') } }),
        });
      }
      if (sandbox && name === 'request_user_action') args = { ...args, commands: args.commands.map(command => ({ ...command,
        cwd: command.cwd === '/workspace' || command.cwd.startsWith('/workspace/')
          ? path.join(root, path.posix.relative('/workspace', containerPath(snapshot, command.cwd))) : command.cwd,
      })) };
      return fn(args, { id, signal, onUpdate });
    } });
  const read = sdk.createReadTool(root);
  const tools = [tool('cc_read', 'Read a file inside allowed roots.', read.parameters, async (args, context) => {
    const file = readPath(args.path, scope);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Read a regular file up to 2 MiB');
    return read.execute(context.id, { ...args, path: file }, context.signal, context.onUpdate);
  }), tool('cc_ls', 'List a directory inside allowed roots.', object({ path: string }, []), args => {
    const dir = readPath(args.path ?? '.', scope);
    return textResult(fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map(x => x.name + (x.isDirectory() ? '/' : '')).join('\n'));
  })];
  for (const name of ['cc_find', 'cc_grep']) tools.push(tool(name,
    name === 'cc_find' ? 'Find files whose relative path contains pattern (literal substring). Skips symlinks and hidden directories.' : 'Search files for a literal substring. Skips symlinks, hidden directories and environment files.',
    object({ pattern: string, path: string }, ['pattern']), (args, c) => {
      const base = readPath(args.path ?? '.', scope), matches = [];
      // Narrow only broad Planner searches. Explicit paths remain readable.
      const excludes = role === 'planner' && base === canonical(profile.commandCenter)
        ? (profile.pi?.plannerSearchExclude ?? []).filter(x => typeof x === 'string' && x) : [];
      let visited = 0;
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (c.signal?.aborted) throw new Error('Search interrupted');
          if (++visited > 10000 || matches.length >= 200) return;
          if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
          const relative = path.relative(base, path.join(dir, entry.name));
          if (excludes.some(x => relative === x || relative.startsWith(x + path.sep))) continue;
          const file = readPath(path.join(dir, entry.name), scope);
          if (entry.isDirectory()) { walk(file); continue; }
          if (!entry.isFile()) continue;
          if (name === 'cc_find') { if (relative.includes(args.pattern)) matches.push(relative); }
          else if (fs.statSync(file).size <= 1024 * 1024) {
            const content = fs.readFileSync(file, 'utf8');
            if (!content.includes('\0')) content.split('\n').forEach((line, index) => {
              if (matches.length < 200 && line.includes(args.pattern)) matches.push(`${relative}:${index + 1}: ${line.slice(0, 500)}`);
            });
          }
        }
      }
      walk(base);
      return textResult(matches.join('\n') + (visited > 10000 || matches.length >= 200 ? '\n[limited; narrow the path]' : ''));
    }));
  if (role !== 'execution-reviewer') tools.push(tool('cc_git', 'Read Git context. One literal read operation; no mutations or shell syntax.', object({ cwd: string, args: { type: 'array', items: string, minItems: 1, maxItems: 64 } }), async (args, c) => {
    const cwd = readPath(args.cwd, scope);
    const normalized = normalizeGitContext({ command: `git -C ${quote(cwd)} --no-pager ${args.args.map(quote).join(' ')}` }, { directory: root, readRoots });
    const result = await execute(['/bin/sh', '-c', normalized.command], { cwd: normalized.workdir, signal: c.signal, timeout: 30, env: gitContextEnvironment,
      audit: { root: profile.stateRoot, stateDir, actor: role, kind: 'git_context', feature: path.basename(stateDir ?? root) } });
    if (result.code !== 0 || result.limited || result.timedOut) throw new Error(result.err || 'Git read failed');
    return textResult(result.out);
  }));
  if (['planner', 'builder'].includes(role)) {
    for (const [name, create] of [['cc_write', sdk.createWriteTool], ['cc_edit', sdk.createEditTool]]) {
      const builtin = create(root);
      tools.push(tool(name, builtin.description + ' Only inside the current writable root.', builtin.parameters, (args, c) => {
        const writeRoot = role === 'planner' ? profile.draftsRoot : root;
        const target = writablePath(writeRoot, args.path, root);
        if (typeof args.content === 'string' && args.content.length > 2 * 1024 * 1024) throw new Error('Write is limited to 2 MiB');
        return builtin.execute(c.id, { ...args, path: target }, c.signal, c.onUpdate);
      }));
    }
  }
  if (role === 'planner') {
    tools.push(tool('cc_prepare', 'Prepare an existing draft task.json and feature worktrees. replace=true updates a prepared plan and invalidates previous approval. Show the plan in /tasks for human approval; does not run Builder.', object({ task_path: string, replace: { type: 'boolean' } }, ['task_path']), async args => {
      const file = readPath(args.task_path, scope);
      if (!inside(profile.draftsRoot, file)) throw new Error('task.json must be in draftsRoot');
      const result = await prepare(profile.filename, file, { replace: args.replace === true });
      options.onPrepared?.(result.id);
      return textResult({ id: result.id, status: result.status, digest: result.digest, next: '/tasks → план → a' });
    }));
    if (profile.pi?.jiraRead) tools.push(tool('cc_jira', 'Read the specified Jira ticket using the configured read-only integration.', object({ ticket: string }), async (args, c) => {
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(args.ticket)) throw new Error('Expected a Jira ticket key');
      const result = await execute(profile.pi.jiraRead.map(x => x.replaceAll('{ticket}', args.ticket)), { cwd: root, signal: c.signal, timeout: 60,
        audit: { root: profile.stateRoot, stateDir, actor: role, kind: 'jira_read' } });
      if (result.code !== 0) throw new Error(result.err);
      return textResult(result.out);
    }));
  }
  if (role === 'builder') {
    if (snapshot?.knowledgeBase && !options.knowledgeStage) tools.push(tool('kb_propose', 'Submit optional knowledge-base updates for this round. Does not write KB files; the user may approve selected proposals after accepting the code. Use [] if none are needed.', object({ proposals: { type: 'array', maxItems: 9, items: object({
      id: string, title: string, paths: { type: 'array', items: string, minItems: 1, maxItems: 20 }, reason: string, evidence: string,
    }) } }), args => textResult(proposeKnowledge(stateDir, args.proposals))));
    if (sandbox) tools.push(tool('cc_exec', 'Execute argv in Docker. cwd is relative to /workspace. For shell scripts use ["sh", "-c", "..."]. No network, host credentials or Git metadata. Output streams into /tasks. /build and /home/agent persist. Final checks run independently.', object({
      argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 128 }, cwd: string, reason: string,
    }, ['argv', 'cwd', 'reason']), (args, c) => containerRun(args.argv, c, { cwd: containerPath(snapshot, args.cwd), kind: 'docker_exec' })));
    tools.push(tool('explore', 'Ask the read-only Explorer to inspect source code and return a concise report. Limited budget; no changes.', object({ question: string }), async (args, c) => textResult(await explore(args.question, c.signal))));
    tools.push(tool('request_user_action', 'Request critical commands from the user. Persist a proposal, stop tools and finish; the UI handles execution.', object({
      repo: string, title: string, reason: string, why_agent_cannot: string,
      commands: { type: 'array', minItems: 1, maxItems: 5, items: object({ command: string, cwd: string }) }, expected_result: string, risks: string,
    }), args => textResult(requestUserAction(args, { stateDir, featureRoot: root, round: state().round, sessionID: sessionID() }))));
    if (profile.devRun.enabled) tools.push(tool('dev_run', 'Run a configured diagnostic target after independent safety/relevance review; uncertainty denies execution.', object({
      repo: string, command: string, target: string, args: { type: 'array', items: { type: 'string' }, maxItems: 32 }, reason: string, expected: string,
      timeout_seconds: { type: 'integer', minimum: 1 },
    }, ['repo', 'command', 'target', 'reason', 'expected']), async (args, c) => textResult(await runDevCommand(args, {
      stateDir, featureRoot: root, round: state().round, signal: c.signal, review: reviewExecution,
    }))));
  }
  if (role === 'reviewer') tools.push(tool('review_submit', 'Submit one final review. Read-only role. All findings require concrete fixes.', JSON.parse(fs.readFileSync(new URL('../../core/schemas/review.schema.json', import.meta.url))), args => {
    const result = parseReview(JSON.stringify(args), state().snapshot.repos.map(x => x.id));
    options.submit?.('review_submit', result);
    return textResult(result);
  }));
  if (role === 'execution-reviewer') tools.push(tool('execution_submit', 'Submit one allow/deny verdict. Deny uncertainty and unrelated or risky commands.', object({
    request_id: string, verdict: { enum: ['allow', 'deny'] }, task_relevant: { type: 'boolean' }, risk: { enum: ['low', 'medium', 'high', 'unknown'] }, reason: string,
    evidence: { type: 'array', items: string, minItems: 1 },
  }), args => {
    const result = parseExecutionReview(args, process.env.CC_EXECUTION_REQUEST_ID);
    options.submit?.('execution_submit', result);
    return textResult(result);
  }));
  if (options.knowledgeStage) return tools.filter(x => ['cc_read', 'cc_ls', 'cc_find', 'cc_grep', 'cc_write', 'cc_edit'].includes(x.name));
  return sandbox ? tools.filter(x => !['cc_git', 'dev_run'].includes(x.name)) : tools;
}
