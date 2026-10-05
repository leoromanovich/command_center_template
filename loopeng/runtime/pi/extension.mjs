import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPi } from './lib/pi.mjs';
import { roleTools, object, textResult } from './lib/tools.mjs';
import { openTasks, stageLabel, taskLabel, dockerBadge, shortcutHint } from './lib/view.mjs';
import { demoProvider, DEMO_NOTICE } from './lib/demo-provider.mjs';
import { loadProfile, status } from '../core/lib/controller.mjs';
import { listTasks } from '../core/lib/background.mjs';
import { canonical } from '../core/lib/policy.mjs';

export default async function commandCenter(pi) {
  if (!process.env.CC_PI_PROFILE) throw new Error('Use ./start --profile <profile.json> to load Command Center');
  const profile = loadProfile(process.env.CC_PI_PROFILE), { ai } = await loadPi();
  if (!profile.pi?.demo) for (const [name, config] of Object.entries(profile.pi?.providers ?? {})) pi.registerProvider(name, config);
  let role = 'planner', taskID, timer, lastStates = new Map(), context;
  const readRoots = [profile.commandCenter, profile.worktreeParent, ...Object.values(profile.repositories).map(x => canonical(path.resolve(profile.commandCenter, x.source))),
    ...(profile.pi?.plannerReadRoots ?? []).map(x => canonical(path.resolve(profile.commandCenter, x))),
    path.join(os.homedir(), '.pi/agent/skills')].filter(x => fs.existsSync(x)).map(canonical);
  const allowed = [], planning = new Set(['cc_write', 'cc_edit', 'cc_prepare', 'cc_jira']);
  function mode(nextRole, id, claimPlanning = false) {
    role = nextRole; taskID = id;
    pi.appendEntry('cc-state', { role, taskID, ...(claimPlanning ? { claimPlanning: true } : {}) });
    pi.setActiveTools(allowed.filter(name => role === 'planner' || !planning.has(name)));
    update();
  }
  const tools = await roleTools({ role: 'planner', root: profile.commandCenter, readRoots, profile, onPrepared: id => mode('planner', id, true) });
  for (const tool of tools) {
    allowed.push(tool.name);
    pi.registerTool({ ...tool, async execute(...args) {
      if (role !== 'planner' && planning.has(tool.name)) throw new Error('This session is in Orchestrator mode; start /plan-new for a new plan.');
      return tool.execute(...args);
    } });
  }
  allowed.push('cc_status');
  pi.registerTool({ name: 'cc_status', label: 'Command Center', description: 'Read task progress, latest Builder/Reviewer result and pending human request. No workflow mutations.', parameters: object({}, []),
    async execute() {
      const s = taskID ? status(profile.filename, taskID) : undefined;
      return textResult({ tasks: listTasks(profile.filename), current: s ? { id: s.id, status: s.status, round: s.round, builderResult: s.builderSummary, review: s.review, pendingUserAction: s.pendingUserAction, error: s.error } : undefined });
    } });
  if (profile.pi?.demo) {
    const provider = () => demoProvider(ai, { role, taskPath: path.join(profile.draftsRoot, 'task.json'),
      findTask: id => listTasks(profile.filename).find(task => task.id === id) });
    pi.registerProvider('cc-demo', { ...provider(), streamSimple(model, ctx, options) { return provider().streamSimple(model, ctx, options); } });
  }
  function update() {
    if (!context || context.mode !== 'tui') return;
    try {
      const tasks = listTasks(profile.filename);
      context.ui.setStatus('cc', `${profile.pi?.demo ? 'DEMO · ' : ''}${role}${taskID ? ' · ' + taskID : ''}`);
      const widget = tasks.length ? [
        'CC  ' + shortcutHint(context.ui.theme, '/tasks задачи · /cc-stats статистика · /plan-new новая задача'),
        ...tasks.slice(-5).map(x => `${x.job?.alive || x.knowledge?.running ? '●' : ['waiting_for_user_action', 'ready_for_user'].includes(x.status) || ['proposed', 'ready', 'failed', 'capture_failed', 'publication_failed'].includes(x.knowledge?.status) ? '!' : '·'} ${x.id}: ${taskLabel(x)}${x.round ? ' · круг ' + x.round : ''}${profile.sandbox ? ' · ' + (dockerBadge(path.join(profile.stateRoot, x.id)) || 'Docker ожидает команду') : ''}`),
      ] : ['CC · Planner: опишите задачу или Jira-тикет', shortcutHint(context.ui.theme, '/tasks история · /cc-stats статистика')];
      if (profile.pi?.demo) widget.unshift(context.ui.theme.fg('mdHeading', DEMO_NOTICE));
      context.ui.setWidget('cc', widget);
      for (const x of tasks) {
        const prior = lastStates.get(x.id);
        const current = `${x.status}:${x.delivery?.status}:${x.workspaceCleanup?.status}:${x.knowledge?.status}`;
        if (prior && prior !== current && ['waiting_for_user_action', 'ready_for_user', 'accepted', 'paused_interrupted', 'blocked'].includes(x.status)) {
          pi.sendMessage({ customType: 'cc-progress', content: `${x.id}: ${taskLabel(x)}. /tasks — открыть задачу.`, display: true }, { triggerTurn: false });
        }
        lastStates.set(x.id, current);
      }
    } catch (error) { context.ui.setStatus('cc', `CC: ${error.message}`); }
  }
  async function newPlan(ctx) {
    await ctx.waitForIdle();
    // session_start restores the fresh role. The old command context is invalid
    // as soon as newSession replaces the foreground runtime.
    await ctx.newSession();
  }
  const open = async (ctx, initial = 'tasks') => {
    context = ctx;
    return openTasks(ctx, profile, { selected: initial === 'tasks' ? undefined : taskID, initial, onRole: mode, onNew: () => newPlan(ctx) });
  };
  pi.registerCommand('tasks', { description: 'Command Center: tasks, live agents, commands and diff', handler: async (_args, ctx) => open(ctx) });
  pi.registerCommand('cc', { description: 'Open Command Center', handler: async (_args, ctx) => open(ctx) });
  pi.registerCommand('cc-stats', { description: 'Token usage and manual costs: all CC, or /cc-stats <task-id>', handler: async (args, ctx) => {
    const id = args.trim();
    if (id && !listTasks(profile.filename).some(task => task.id === id)) throw new Error(`Unknown CC task: ${id}`);
    return openTasks(ctx, profile, { selected: id || undefined, initial: id ? 'usage-task' : 'usage-cc' });
  } });
  pi.registerCommand('watch', { description: 'Observe current task without switching agent sessions', handler: async (_args, ctx) => open(ctx, 'task') });
  pi.registerCommand('review', { description: 'Review the current task diff', handler: async (_args, ctx) => open(ctx, 'review') });
  pi.registerCommand('plan-new', { description: 'Start a fresh Planner session', handler: async (_args, ctx) => newPlan(ctx) });
  pi.on('session_start', async (_event, ctx) => {
    clearInterval(timer); context = ctx;
    const saved = ctx.sessionManager.getBranch().findLast(x => x.type === 'custom' && x.customType === 'cc-state')?.data;
    role = saved?.role ?? 'planner'; taskID = saved?.taskID;
    pi.setActiveTools(allowed.filter(name => role === 'planner' || !planning.has(name)));
    lastStates = new Map(); update(); timer = setInterval(update, 1000); timer.unref?.();
    if (profile.pi?.demo && ctx.model?.provider !== 'cc-demo') {
      const model = ctx.modelRegistry.find('cc-demo', 'scripted'); if (model) await pi.setModel(model);
    }
  });
  pi.on('session_shutdown', async () => { clearInterval(timer); context = undefined; });
  pi.on('before_agent_start', async event => {
    pi.setActiveTools(allowed.filter(name => role === 'planner' || !planning.has(name)));
    const instructions = role === 'planner'
      ? `You are Planner in Command Center. Discuss requirements; ask clarifying questions in the ordinary chat and use available skills when requested. Do not implement the feature. Read Command Center knowledge. Draft a Markdown plan and task.json under ${profile.draftsRoot}. Use a fresh unique task id for every new task. task.json: {id,source:{kind:"local"} or {kind:"jira",key:"KEY-1"},plan:"relative.md",repositories:[ids],acceptance:[criteria],worktrees:{repo:{base:"ref",branch:"feature/name"}},publication:{commit:false,push:false,mergeRequest:false,jiraUpdate:false}}. Repository configuration: ${JSON.stringify(profile.repositories)}. Ask about base/feature branches and publication. Use cc_prepare to create the configured worktrees. Show the plan, then direct the user to /tasks → plan → a to approve the exact snapshot. Never imply that approval was granted by a tool response. Jira context uses cc_jira when configured.`
      : `You are Orchestrator for ${taskID}. Use cc_status for actual progress and explain the pipeline and results concisely. The background controller enforces Builder → format/lint/tests → Reviewer and repair loops. The user controls approval, execution of requested commands, diff/feedback and acceptance in /tasks. After acceptance, u opens publication: inspect files/message, select local commit/push/MR, then Enter. Git and MR wait for this human confirmation. c checks merge ancestry before worktree cleanup. Never fabricate state, run shell or approve on the user's behalf.`;
    return { systemPrompt: event.systemPrompt + '\n\n' + instructions };
  });
}
