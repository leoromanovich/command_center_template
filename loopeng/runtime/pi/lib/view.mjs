import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadPi } from './pi.mjs';
import { streams, tail, jsonLines } from './events.mjs';
import { terminalProcess } from './terminal.mjs';
import { status, approve, resume, feedback, resolveUserAction } from '../../core/lib/controller.mjs';
import { listTasks, startRun, stopRun, jobStatus } from '../../core/lib/background.mjs';
import { previewPublication, previewCleanup, reconcilePublication } from '../../core/lib/publication.mjs';
import { loadHumanReview } from '../../core/lib/human-review.mjs';
import { previewUserCommand, runUserCommand, userCommandRuns, completedUserCommands } from '../../core/lib/user-terminal.mjs';
import { editorArgv } from '../../core/tui/review-editor.mjs';
import { commandDocument } from '../../core/tui/documents.mjs';
import { alive } from '../../core/lib/recovery.mjs';
import { unfinishedCommands } from '../../core/lib/audit.mjs';
import { dockerActivity } from '../../core/lib/docker.mjs';
import { previewKnowledge, decideKnowledge, startKnowledgeJob, stopKnowledgeJob, previewKnowledgePublication, retryKnowledgeCapture, feedbackKnowledge } from '../../core/lib/knowledge.mjs';
import { knowledgeLabel, knowledgeDocument, knowledgePublicationDocument } from './knowledge-view.mjs';
import { shortcutInput } from './keyboard.mjs';
import { createUsageReader, usageDocument } from './usage.mjs';
import { createLiveRenderer, splitLines } from './live-view.mjs';
import { overlayPointer } from './pointer.mjs';

const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const pretty = value => JSON.stringify(value, null, 2);
const names = { prepared: 'план готов', approved: 'план утверждён', building: 'Builder', checking: 'проверки', reviewing: 'Reviewer',
  ready_for_user: 'нужно ваше ревью', waiting_for_user_action: 'нужна ваша команда', accepted: 'принято', paused_interrupted: 'прервано', blocked: 'заблокировано' };
export const stageLabel = state => names[state] ?? state;
export function taskLabel(item) {
  if (item.knowledge) return taskLabel({ ...item, knowledge: undefined }) + ' · база: ' + knowledgeLabel(item.knowledge);
  if (item.job?.alive && item.job.action === 'publish-accepted') return 'публикация';
  if (item.job?.alive && item.job.action === 'cleanup-accepted') return 'очистка worktree';
  if (item.workspaceCleanup?.status === 'done') return 'принято · worktree удалён';
  if (item.delivery?.status === 'pending') return 'принято · публикация прервана';
  if (item.delivery?.status === 'done') return 'принято · опубликовано';
  return stageLabel(item.status);
}
const shortcutColors = {
  a: 'success', l: 'success', v: 'success',
  n: 'customMessageLabel', e: 'customMessageLabel', m: 'customMessageLabel', b: 'customMessageLabel', '/plan-new': 'customMessageLabel',
  u: 'mdHeading', t: 'mdHeading', '/cc-stats': 'mdHeading', 1: 'mdHeading', 2: 'mdHeading', 3: 'mdHeading', f: 'mdHeading', z: 'mdHeading',
  s: 'error', d: 'error', x: 'error', c: 'error', 'Ctrl+u': 'error',
  q: 'muted', Esc: 'muted',
};
const enterColors = { publication: 'mdHeading', 'knowledge-publication': 'mdHeading', knowledge: 'success', cleanup: 'error', action: 'success', recovery: 'success',
  feedback: 'success', 'knowledge-feedback': 'success', answer: 'success', 'commit-message': 'success', 'mr-result': 'success' };
export function shortcutHint(theme, value, route = '') {
  return value.split(' · ').map(part => {
    const space = part.indexOf(' '), key = space < 0 ? part : part.slice(0, space), description = space < 0 ? '' : part.slice(space);
    const color = key === 'Enter' ? enterColors[route] ?? 'mdLink'
      : route === 'action' && key === 'm' ? 'success'
      : route === 'task' && key === 'e' ? 'mdHeading'
      : shortcutColors[key] ?? 'mdLink';
    return theme.fg(color, key) + theme.fg('muted', description);
  }).join(theme.fg('dim', ' · '));
}
const deliveryNames = { commit: 'Локальный коммит', push: 'Коммит и push', mr: 'Коммит, push и MR' };
export function publicationDocument(p) {
  return `# ${p.done ? '✓ ' : ''}${deliveryNames[p.mode]}\n\n${p.pending ? '**Публикация прервана. Продолжение использует сохранённые параметры.**\n\n' : ''}${p.error ?? ''}\n\n` +
    p.repositories.map(repo => `## ${repo.id} → ${repo.branch}\n\n${repo.committed || p.done ? 'Коммит уже создан; повторного коммита не будет.' : 'В коммит входят все перечисленные изменения принятого результата.'}\n\n${repo.files.map(f => `- ${f.change} ${JSON.stringify(f.name)}`).join('\n')}\n\nСообщение:\n\n\`\`\`text\n${p.spec.messages[repo.id]}\n\`\`\`\n\n${p.spec.targets.find(x => x.repo === repo.id)?.url ? 'Push: ' + p.spec.targets.find(x => x.repo === repo.id).url : 'Push выключен.'}`).join('\n\n') +
    (p.mrHook ? `\n\nMR adapter:\n\n\`\`\`json\n${pretty(p.mrHook)}\n\`\`\`` : '') +
    (p.mergeRequest?.url ? `\n\nMR: [${p.mergeRequest.id}](${p.mergeRequest.url})` : '') +
    `\n\nПосле merge: c → проверить и удалить worktree. Ветки, отчёты и логи сохраняются.`;
}
export function dockerBadge(dir) {
  const records = [...dockerActivity(dir), ...dockerActivity(path.join(dir, 'knowledge-update'))], active = records.filter(x => x.live);
  if (active.length) return `Docker ● ${active.map(x => `${x.role}: ${x.argv.join(' ').slice(0, 80)}`).join(' · ')}`;
  return records.some(x => ['running', 'cleanup_failed'].includes(x.status)) ? 'Docker ! проверьте прерванный запуск' : '';
}
export function dockerDocument(dir) {
  return [...dockerActivity(dir), ...dockerActivity(path.join(dir, 'knowledge-update'))].reverse().map(x => `### ${x.role} · ${x.status}\n\n${x.container}\n\n${x.cwd} · ${x.readonly ? 'source RO' : 'source RW'} · exit ${x.code ?? '…'}\n\n\`\`\`sh\n${x.argv.join(' ')}\n\`\`\``).join('\n\n') || 'Контейнерных команд пока нет. Модель работает на хосте; команды запускаются в Docker.';
}
export function streamText(stream) {
  const submissions = new Map();
  return stream.events.map(e => {
    if (e.type === 'docker_started') return `\n\n### Docker · ${e.role} · ${e.readonly ? 'RO' : 'RW'}\n\n${e.container}\n${e.cwd}\n\n\`\`\`sh\n${e.argv.join(' ')}\n\`\`\`\n`;
    if (e.type === 'docker_output') return `\n\`\`\`text\n${e.text}\n\`\`\`\n`;
    if (e.type === 'docker_finished') return `\nDocker ${e.status} · exit ${e.code ?? '?'}\n`;
    if (['text_delta', 'thinking_delta'].includes(e.type)) return e.text;
    if (e.type === 'tool') {
      if (e.id && ['review_submit', 'execution_submit'].includes(e.name)) submissions.set(e.id, e);
      return `\n\n### ${e.name}\n\n\`\`\`json\n${pretty(e.args)}\n\`\`\`\n`;
    }
    if (e.type === 'tool_result' && !e.error) {
      const call = submissions.get(e.id), content = e.result?.content;
      if (call?.name === e.name && Array.isArray(content) && content.length === 1 && content[0].type === 'text') {
        try {
          if (isDeepStrictEqual(JSON.parse(content[0].text), call.args)) return `\n✓ ${e.name}: заключение принято.\n`;
        } catch {}
      }
    }
    if (['tool_result', 'tool_update'].includes(e.type)) return `\n\`\`\`text\n${e.result?.content?.map(x => x.text ?? '[image]').join('\n') ?? pretty(e.result)}\n\`\`\`\n`;
    if (e.type === 'usage') return `\n\nTokens: ${e.usage?.totalTokens ?? '?'} · ${e.stopReason}\n\n`;
    if (e.type === 'session') return `\n${e.model} · context ${e.contextWindow}\n\n`;
    return `\n[${e.at}] ${e.type}${e.text ? ': ' + e.text : ''}\n`;
  }).join('');
}

export async function openTasks(ctx, profile, { selected, initial = 'tasks', onRole = () => {}, onNew = () => {} } = {}) {
  if (ctx.mode !== 'tui') throw new Error('Open /tasks in the interactive pi terminal');
  const { sdk, tui: widgets } = await loadPi();
  const readUsage = createUsageReader(profile);
  let overlayHandle;
  return ctx.ui.custom((tui, theme, kb, done) => {
    let route = 'tasks', id = selected, index = 0, scroll = 0, follow = true, busy = false, error = '', document = '', title = '',
      review, plan, packet, preview, publication, cleanup, knowledge, knowledgePublication, knowledgeSelected = new Set(), afterAccept = false, afterPublish = false,
      watchFile, textInput = '', lastKey = '', rows = [], disposed = false;
    let usageReturn = 'close';
    let liveFocus = false, liveScroll = 0, liveFollow = true, liveFile, expandedTools = false, lastWidth = 120, liveKey = '';
    let geometry;
    const live = createLiveRenderer({ sdk, widgets, theme, tui, cwd: profile.commandCenter });
    const pointer = overlayPointer(tui, () => overlayHandle?.getBounds?.() ?? (geometry && {
      row: Math.max(0, Math.floor((tui.terminal.rows - geometry.height) / 2)), col: 0, width: lastWidth, height: geometry.height,
    }), event => mouse(event));
    const runTerminal = async (...args) => {
      pointer.disable();
      try { return await terminalProcess(tui, ...args); }
      finally { if (!disposed) pointer.enable(); }
    };
    const usageRoute = () => ['usage-cc', 'usage-task'].includes(route);
    const dir = () => path.join(profile.stateRoot, id);
    const state = () => status(profile.filename, id);
    const redraw = () => { if (!disposed) tui.requestRender(); };
    const positions = new Map();
    const positionKey = () => route === 'tasks' ? route : `${id}:${route}:${route === 'watch' ? watchFile : ''}`;
    const reset = next => {
      positions.set(positionKey(), { index, scroll, follow });
      route = next;
      liveFocus = false;
      const saved = positions.get(positionKey());
      index = saved?.index ?? 0; scroll = saved?.scroll ?? 0; follow = saved?.follow ?? ['watch', 'checks'].includes(next); error = '';
    };
    const action = async fn => {
      if (busy) return; busy = true; error = ''; redraw();
      try { await fn(); } catch (err) { error = err.message; }
      finally { busy = false; redraw(); }
    };
    const task = () => { reset('task'); onRole(state().status === 'prepared' ? 'planner' : 'orchestrator', id); };
    const visibleStream = () => {
      const all = streams(dir()), selectedFile = rows[index]?.file;
      return all.find(x => x.file === selectedFile) ?? all.find(x => !['finished', 'failed'].includes(x.last?.type) && alive(x.events[0]?.owner)) ?? all[0];
    };
    const watch = () => { watchFile = visibleStream()?.file; reset('watch'); scroll = 0; follow = true; };
    const streamHeading = stream => stream ? `${stream.role}${stream.stage === 'knowledge' ? ' · база' : ''} · круг ${stream.events[0]?.round ?? '?'} · ${stream.last?.type === 'finished' ? 'завершён' : stream.last?.type === 'failed' ? 'ошибка' : alive(stream.events[0]?.owner) ? 'работает' : 'прерван'}` : 'Агент · live';
    const openUsage = scope => { usageReturn = route; reset(scope); };
    const openPlan = () => {
      plan = state(); reset('plan'); title = `${id} · план`;
      document = `${plan.snapshot.plan}\n\n## Репозитории и Git\n\n${plan.snapshot.repos.map(r => `- **${r.id}**: ${r.branch}; база ${r.base}\n  ${r.root}`).join('\n')}\n\n## Критерии\n\n${plan.snapshot.task.acceptance.map(x => '- ' + x).join('\n')}\n\n## Проверки\n\n\`\`\`json\n${pretty(plan.snapshot.repos.map(r => ({ id: r.id, checks: r.checks })))}\n\`\`\`\n\n## Публикация\n\n\`\`\`json\n${pretty(plan.snapshot.publication)}\n\`\`\`\n\nDigest: ${plan.digest}`;
      if (plan.snapshot.sandbox) document += `\n\n## Docker\n\nОбраз: ${plan.snapshot.sandbox.image}\n\nID: ${plan.snapshot.sandbox.imageID}\n\nСеть: none. Builder и formatter: исходники RW. Explorer, Reviewer, lint и тесты: исходники RO.\n\nКонтекст /context: ${plan.snapshot.sandbox.context?.map(x => x.name).join(', ') || 'пусто'}.\n\ncc_exec запускает команды внутри контейнера. Запросы пользователю исполняются на хосте.`;
    };
    const openReview = async () => {
      if (state().workspaceCleanup?.status === 'done') {
        reset('archive'); title = 'Архив принятого diff';
        document = `# ${state().review?.summary ?? 'Результат принят'}\n\nWorktree удалён после merge. Ветки и история сохранены.\n\n\`\`\`diff\n${tail(path.join(dir(), 'changes.diff'), 1024 * 1024)}\n\`\`\``; return;
      }
      review = await loadHumanReview(profile.filename, id); reset('review'); title = `${id} · diff · круг ${review.round}`;
      document = `# ${review.summary}\n\n${review.warnings.join('\n\n')}\n\n${review.findings.map(x => `- ${x.severity}: ${x.repository}/${x.path}: ${x.reason}; ${x.fix}`).join('\n')}\n\n## Проверки\n\n${review.checks.map(x => `- ${x.passed ? '✓' : '✗'} ${x.repo}/${x.phase}`).join('\n')}\n\n` + review.files.map(x => `## ${x.repo}/${x.path}\n\n${x.message ?? ''}\n\n\`\`\`diff\n${x.patch ?? ''}\n\`\`\``).join('\n\n');
    };
    const openPublication = async (options = {}) => {
      publication = await previewPublication(profile.filename, id, options);
      reset('publication'); title = 'Публикация принятого результата'; document = publicationDocument(publication);
    };
    const openCleanup = async () => {
      cleanup = await previewCleanup(profile.filename, id); reset('cleanup'); title = 'Очистка после merge';
      document = `# Удалить worktree\n\nПроверено: рабочие каталоги чистые, коммиты входят в указанные merge-ветки.\n\n${cleanup.repositories.map(r => `- ${r.id}: ${r.root}\n  ${r.head} → ${r.mergeRef} (${r.target})`).join('\n')}\n\nВетки, отчёты, логи и кеши сохраняются. Merge эта команда не выполняет.\n\nEnter удалит только перечисленные worktree. q отменит действие.`;
    };
    const openKnowledge = () => {
      knowledge = previewKnowledge(profile.filename, id);
      knowledgeSelected = new Set(knowledge.approval?.ids ?? knowledge.proposals?.map(p => p.id) ?? []);
      reset('knowledge'); title = 'База знаний';
    };
    const openKnowledgePublication = async (mode) => {
      knowledgePublication = await previewKnowledgePublication(profile.filename, id, { mode });
      reset('knowledge-publication'); title = 'Публикация базы'; document = knowledgePublicationDocument(knowledgePublication);
    };
    const openAction = () => {
      const s = state(); packet = s.pendingUserAction;
      if (!packet) throw new Error('Нет ожидающего запроса');
      const runs = userCommandRuns(profile.filename, id, packet.id), complete = completedUserCommands(packet, runs);
      const next = complete.findIndex(x => !x);
      preview = next >= 0 ? previewUserCommand(profile.filename, id, packet.id, next) : undefined;
      reset('action'); title = `${id} · ${packet.request.title}`;
      document = `${s.snapshot.sandbox ? '**Выполнение на хосте.**\n\n' : ''}${packet.request.reason}\n\n**Почему нужен пользователь:** ${packet.request.why_agent_cannot}\n\n**Риски:** ${packet.request.risks}\n\n**Ожидается:** ${packet.request.expected_result}\n\n` + packet.request.commands.map((x, i) => `### ${complete[i] ? '✓' : '○'} Команда ${i + 1}\n\nКаталог: ${x.cwd}\n\n\`\`\`sh\n${x.command}\n\`\`\``).join('\n\n') +
        (preview?.previous.length ? `\n\nПредыдущие попытки:\n\n\`\`\`json\n${pretty(preview.previous)}\n\`\`\`` : '');
    };
    const finishAction = async () => {
      const runs = userCommandRuns(profile.filename, id, packet.id);
      if (!completedUserCommands(packet, runs).every(Boolean)) return;
      await resolveUserAction(profile.filename, id, packet.id, { outcome: 'completed', summary: 'Команды выполнены пользователем в терминале pi.', output: runs.map(x => `${x.command}: exit ${x.exit_code}`).join('\n') }, { expectedRequest: packet.request });
      await startRun(profile.filename, id); task();
    };
    function refreshRows() {
      if (route === 'tasks') rows = listTasks(profile.filename).map(x => ({ label: `${x.id}  ·  ${taskLabel(x)}${x.job?.alive ? ' ●' : ''}`, task: x.id }));
      else if (route === 'task') {
        const all = streams(dir()).reverse();
        rows = [{ label: 'Обсудить с Orchestrator', page: 'orchestrator' },
          { label: 'План и согласованные действия', page: 'plan' }, { label: 'Проверки · live stdout', page: 'checks' },
          ...(state().snapshot.sandbox ? [{ label: dockerBadge(dir()) || 'Docker · история команд', page: 'docker' }] : []),
          { label: 'Журнал команд и состояние контроллера', page: 'journal' },
          ...all.map(x => ({ label: `${x.parent ? '  ↳ ' : ''}${x.role}${x.stage === 'knowledge' ? ' · база знаний' : ''} · круг ${x.events[0]?.round} · ${x.last?.type === 'finished' ? '✓' : x.last?.type === 'failed' ? '✗' : alive(x.events[0]?.owner) ? '●' : 'прерван'} · ${x.events[0]?.sessionID?.slice(-8)}`, file: x.file })),
          { label: 'Diff и заключение Reviewer', page: 'review' },
          ...(state().snapshot.knowledgeBase ? [{ label: 'База знаний · ' + knowledgeLabel(previewKnowledge(profile.filename, id)), page: 'knowledge' }] : []),
          ...(state().status === 'accepted' ? [{ label: state().workspaceCleanup?.status === 'done' ? 'Worktree удалён · архив доступен в diff' : state().delivery?.status === 'done' ? '✓ Публикация завершена · результат и очистка' : 'Опубликовать принятый результат', page: state().workspaceCleanup?.status === 'done' ? 'review' : 'publication' }] : []),
          { label: 'Статистика · токены и стоимость', page: 'usage-task' }];
      }
      index = Math.max(0, Math.min(index, rows.length - 1));
    }
    async function input(data) {
      if (pointer.input(data)) return;
      if (busy || widgets.isKeyRelease(data)) return;
      const shortcut = shortcutInput(data, widgets);
      const key = value => widgets.matchesKey(shortcut, value);
      if (['feedback', 'answer', 'commit-message', 'mr-result', 'knowledge-feedback'].includes(route)) {
        if (key('escape')) { route = route === 'knowledge-feedback' ? 'knowledge' : ['commit-message', 'mr-result'].includes(route) ? 'publication' : route === 'feedback' ? 'review' : 'action'; return redraw(); }
        if (key('enter')) return action(async () => {
          if (!textInput.trim()) throw new Error('Введите текст');
          if (route === 'knowledge-feedback') {
            await feedbackKnowledge(profile.filename, id, { fingerprint: knowledge.checkedFingerprint, text: textInput.trim() });
            await startKnowledgeJob(profile.filename, id); return openKnowledge();
          }
          if (route === 'commit-message') return openPublication({ mode: publication.mode, message: textInput.trim() });
          if (route === 'mr-result') {
            const [resourceID, url] = textInput.trim().split(/\s+/);
            await reconcilePublication(profile.filename, id, { expectedToken: publication.token, applied: true, resourceID, url });
            return openPublication();
          }
          if (route === 'answer') await resolveUserAction(profile.filename, id, packet.id, { outcome: 'completed', summary: textInput.trim(), output: textInput.trim() }, { expectedRequest: packet.request });
          else await feedback(profile.filename, id, textInput.trim(), { expectedDigest: review.digest, expectedFingerprint: review.fingerprint });
          await startRun(profile.filename, id); task();
        });
        if (key('ctrl+u')) textInput = '';
        else if (key('backspace')) textInput = [...textInput].slice(0, -1).join('');
        else if (data.startsWith('\x1b[200~')) textInput += clean(data.slice(6).replace(/\x1b\[201~$/, '')).replace(/\r|\n/g, ' ');
        else if (widgets.decodeKittyPrintable(data)) textInput += widgets.decodeKittyPrintable(data);
        else if (!data.startsWith('\x1b')) textInput += clean(data).replace(/\r|\n/g, ' ');
        return redraw();
      }
      data = shortcut;
      if (route === 'task' && key('tab')) {
        if (lastWidth < 110) watch(); else liveFocus = !liveFocus;
        return redraw();
      }
      if (route === 'task' && data === 'w') { watch(); return redraw(); }
      if ((route === 'task' && liveFocus || route === 'watch') && data === 'o') { expandedTools = !expandedTools; return redraw(); }
      if (route === 'task' && liveFocus && (['j', 'k', 'g', 'G', 'l', ' '].includes(data) || ['up', 'down', 'pageup', 'pagedown', 'enter'].some(key))) {
        if (key('enter')) { watch(); return redraw(); }
        if (data === 'j' || key('down')) { liveScroll++; liveFollow = false; }
        if (data === 'k' || key('up')) { liveScroll = Math.max(0, liveScroll - 1); liveFollow = false; }
        if (key('pagedown') || data === ' ') { liveScroll += 15; liveFollow = false; }
        if (key('pageup')) { liveScroll = Math.max(0, liveScroll - 15); liveFollow = false; }
        if (data === 'g' && liveKey === 'g') { liveScroll = 0; liveFollow = false; }
        if (data === 'G') { liveScroll = 1e9; liveFollow = false; }
        if (data === 'l') liveFollow = true;
        liveKey = data === 'g' ? 'g' : '';
        return redraw();
      }
      liveKey = '';
      if (usageRoute() && (key('escape') || data === 'q')) { if (usageReturn === 'close') done(); else reset(usageReturn); return redraw(); }
      if (data === 't' && ['tasks', 'task'].includes(route)) { openUsage(route === 'tasks' ? 'usage-cc' : 'usage-task'); return redraw(); }
      if (key('escape') || data === 'q') { if (route === 'tasks') done(); else if (route === 'task') reset('tasks'); else task(); return redraw(); }
      if (data === 'n' && (route === 'tasks' || route === 'task' && state().status === 'accepted')) { done('new'); return; }
      if (['tasks', 'task'].includes(route)) {
        if (data === 'j' || key('down')) index = Math.min(rows.length - 1, index + 1);
        if (data === 'k' || key('up')) index = Math.max(0, index - 1);
        if (key('enter') && rows[index]) return action(async () => {
          const row = rows[index];
          if (row.task) { id = row.task; task(); }
          else if (row.page === 'orchestrator') { onRole('orchestrator', id); done(); }
          else if (row.page === 'plan') openPlan();
          else if (row.page === 'review') await openReview();
          else if (row.page === 'publication') await openPublication();
          else if (row.page === 'knowledge') openKnowledge();
          else if (row.page === 'checks') reset('checks');
          else if (row.page === 'docker') { reset('docker'); title = 'Docker · контейнеры и команды'; }
          else if (row.page === 'journal') { reset('journal'); title = 'Журнал команд'; }
          else if (row.page === 'usage-task') openUsage('usage-task');
          else { watchFile = row.file; reset('watch'); }
        });
      } else {
        if (data === 'j' || key('down')) { scroll++; follow = false; }
        if (data === 'k' || key('up')) { scroll = Math.max(0, scroll - 1); follow = false; }
        if (key('pagedown') || data === ' ') { scroll += 15; follow = false; }
        if (key('pageup')) { scroll = Math.max(0, scroll - 15); follow = false; }
        if (data === 'g' && lastKey === 'g') { scroll = 0; follow = false; }
        if (data === 'G') { scroll = 1e9; follow = false; }
        if (data === 'l') follow = true;
      }
      lastKey = data === 'g' ? data : '';
      if (id && data === 'p' && route === 'task') return action(openPlan);
      if (id && data === 'r' && route === 'task') return action(openReview);
      if (id && data === 'u' && ['task', 'review'].includes(route) && state().status === 'accepted') return action(() => openPublication());
      if (id && data === 'b' && ['task', 'review', 'publication', 'archive'].includes(route) && state().snapshot.knowledgeBase) return action(openKnowledge);
      if (id && data === 'e' && route === 'task') return action(openAction);
      if (id && data === 's' && route === 'task') return action(() => stopRun(profile.filename, id));
      if (data === 'a' && route === 'plan') return action(async () => {
        await approve(profile.filename, id, plan.digest); await startRun(profile.filename, id); task();
      });
      if (data === 'a' && route === 'task') return action(async () => {
        const s = state();
        if (s.status === 'prepared') return openPlan();
        if (s.status === 'waiting_for_user_action') return openAction();
        if (s.status === 'ready_for_user') return openReview();
        if (s.status === 'accepted') return s.workspaceCleanup?.status === 'done' ? openReview() : openPublication();
        if (s.status === 'blocked') return openReview();
        if (s.status === 'paused_interrupted') {
          if (unfinishedCommands(dir()).length) {
            reset('recovery'); title = 'Восстановление после неизвестного исхода';
            document = '**Проверьте фактический результат команд ниже и текущие файлы.** После подтверждения Builder получит сохранённый контекст и указание проверить состояние перед продолжением.\n\n' + commandDocument(dir()).content;
            return;
          }
          await resume(profile.filename, id);
        }
        await startRun(profile.filename, id);
      });
      if (route === 'recovery' && key('enter')) return action(async () => {
        await resume(profile.filename, id, { acknowledgeUnknown: true }); await startRun(profile.filename, id); task();
      });
      if (data === 'a' && route === 'review') return action(async () => {
        if (!review.canAccept) throw new Error(review.acceptReason);
        await startRun(profile.filename, id, { action: 'accept', expectedDigest: review.digest, expectedFingerprint: review.fingerprint }); afterAccept = id; task();
      });
      if (route === 'publication') {
        const modes = { '1': 'commit', '2': 'push', '3': 'mr' };
        if (modes[data] && !publication.pending) return action(() => openPublication({ mode: modes[data], message: publication.message }));
        if (data === 'm' && publication.canEditMessage && !publication.pending) { route = 'commit-message'; textInput = publication.message; return redraw(); }
        if (data === 'c') return action(openCleanup);
        if (data === 'v' && publication.mergeRequest?.status === 'started') { route = 'mr-result'; textInput = ''; return redraw(); }
        if (data === 'z' && publication.mergeRequest?.status === 'started') return action(async () => {
          await reconcilePublication(profile.filename, id, { expectedToken: publication.token, applied: false }); await openPublication();
        });
        if (key('enter') && !publication.done) return action(async () => {
          await startRun(profile.filename, id, { action: 'publish-accepted', expectedToken: publication.token, mode: publication.mode, message: publication.message });
          afterPublish = id; task();
        });
      }
      if (route === 'cleanup' && key('enter')) return action(async () => {
        await startRun(profile.filename, id, { action: 'cleanup-accepted', expectedToken: cleanup.token }); task();
      });
      if (route === 'knowledge') {
        if (data === 'f' && knowledge.status === 'ready' && !knowledge.publication) { route = 'knowledge-feedback'; textInput = ''; return redraw(); }
        if (data === 'c' && knowledge.status === 'capture_failed') return action(async () => { await retryKnowledgeCapture(profile.filename, id); openKnowledge(); });
        const selectable = ['proposed', 'rejected', 'awaiting_acceptance'].includes(knowledge.status);
        const proposal = knowledge.proposals?.[Number(data) - 1];
        if (/^[1-9]$/.test(data) && selectable && proposal) {
          if (knowledgeSelected.has(proposal.id)) knowledgeSelected.delete(proposal.id); else knowledgeSelected.add(proposal.id);
        }
        if (key('enter') && !knowledge.job?.alive) return action(async () => {
          if (['proposed', 'rejected'].includes(knowledge.status)) await decideKnowledge(profile.filename, id, { expectedToken: knowledge.token, ids: [...knowledgeSelected] });
          else if (!['approved', 'running', 'failed'].includes(knowledge.status)) throw new Error('Сначала примите код; затем выберите предложения для базы.');
          await startKnowledgeJob(profile.filename, id); openKnowledge();
        });
        if (data === 'd' && selectable) return action(async () => {
          await decideKnowledge(profile.filename, id, { expectedToken: knowledge.token, reject: true }); openKnowledge();
        });
        if (data === 's' && knowledge.job?.alive) return action(() => stopKnowledgeJob(profile.filename, id));
        if (data === 'u') return action(() => openKnowledgePublication());
        if (data === 'e' && knowledge.diff) return action(async () => {
          const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kb-review-'));
          try { const file = path.join(temp, 'knowledge.diff'); fs.writeFileSync(file, knowledge.diff, { mode: 0o400 });
            await runTerminal(editorArgv(profile.reviewEditor, file, process.env), temp);
          } finally { fs.rmSync(temp, { recursive: true, force: true }); }
        });
      }
      if (route === 'knowledge-publication') {
        if (['1', '2'].includes(data) && !knowledgePublication.pending) return action(() => openKnowledgePublication(data === '1' ? 'commit' : 'push'));
        if (key('enter') && !knowledgePublication.done) return action(async () => {
          await startKnowledgeJob(profile.filename, id, { action: 'publish', expectedToken: knowledgePublication.token, mode: knowledgePublication.mode }); openKnowledge();
        });
      }
      if (data === 'f' && route === 'review') { if (!review.canFeedback) error = 'Исправления сейчас недоступны'; else { route = 'feedback'; textInput = ''; } }
      if (data === 'e' && route === 'review') return action(async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cc-review-'));
        try {
          const file = path.join(temp, 'review.diff');
          fs.writeFileSync(file, '# :q → pi; a → принять; f → исправить\n' + review.files.map(x => `# ${x.repo}/${x.path}\n${x.patch ?? x.message}`).join('\n'), { mode: 0o400 });
          const argv = editorArgv(profile.reviewEditor, file, process.env, review);
          if (/^(?:nvim|vim|vi|view|nview)$/.test(path.basename(argv[0]))) argv.splice(argv.indexOf('--'), 0, '-c', "let &l:statusline = ':q → pi | a: принять результат | f: исправить'");
          await runTerminal(argv, temp);
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      });
      if (route === 'action' && key('enter')) return action(async () => {
        if (preview) {
          if (preview.previous.some(x => ['running', 'error', 'cancelled'].includes(x.status))) throw new Error('Исход предыдущей попытки нужно проверить вручную. Повтор автоматически заблокирован.');
          await runUserCommand(profile.filename, id, preview, (p, callbacks) => runTerminal([p.shell, '-c', p.command], p.resolvedCwd, callbacks));
        }
        await finishAction(); if (route === 'action') openAction();
      });
      if (route === 'action' && data === 'd') return action(async () => {
        await resolveUserAction(profile.filename, id, packet.id, { outcome: 'declined', summary: 'Пользователь отклонил запуск в pi.', output: '' }, { expectedRequest: packet.request });
        await startRun(profile.filename, id); task();
      });
      if (route === 'action' && data === 'm') { route = 'answer'; textInput = ''; }
      if (route === 'action' && data === 'x') return action(async () => {
        const runs = userCommandRuns(profile.filename, id, packet.id);
        await resolveUserAction(profile.filename, id, packet.id, { outcome: 'failed', summary: 'Пользователь вернул неуспешный запрос Builder.', output: pretty(runs) }, { expectedRequest: packet.request });
        await startRun(profile.filename, id); task();
      });
      redraw();
    }
    function mouse(event) {
      const handled = { handled: true, render: false };
      if (disposed || busy || !geometry || event.shift || event.alt || event.ctrl) return handled;
      if (event.y < 3 || event.y >= 3 + geometry.contentHeight) return handled;
      const wheel = event.type === 'wheel' && Number.isFinite(event.wheelDelta) && event.wheelDelta !== 0;
      const click = ['press', 'click'].includes(event.type) && event.button === 'left';
      if (!wheel && !click) return handled;
      if (['tasks', 'task'].includes(route)) {
        const right = route === 'task' && geometry.leftWidth !== undefined && event.x >= geometry.leftWidth + 3;
        liveFocus = right; liveKey = ''; lastKey = '';
        if (right) {
          if (wheel) { liveScroll = Math.max(0, liveScroll + Math.trunc(event.wheelDelta)); liveFollow = false; }
        } else {
          if (wheel) index = Math.max(0, Math.min(rows.length - 1, index + Math.trunc(event.wheelDelta)));
          else {
            const selectedIndex = geometry.listTop + event.y - 3;
            if (rows[selectedIndex]) index = selectedIndex;
          }
        }
      } else if (['feedback', 'answer', 'commit-message', 'mr-result', 'knowledge-feedback'].includes(route)) return handled;
      else if (wheel) { scroll = Math.max(0, scroll + Math.trunc(event.wheelDelta)); follow = false; lastKey = ''; }
      redraw(); return { handled: true, focus: true };
    }
    const component = {
      invalidate() { live.invalidate(); },
      dispose() { disposed = true; clearInterval(timer); pointer.disable(); },
      handleInput(data) { void input(data).catch(e => { error = e.message; redraw(); }); },
      handleMouse: mouse,
      render(width) {
        lastWidth = width;
        refreshRows();
        const height = Math.max(8, tui.terminal.rows - 4), contentHeight = height - 6;
        geometry = { contentHeight, listTop: Math.max(0, index - contentHeight + 1) };
        const allTasks = listTasks(profile.filename), pending = allTasks.filter(x => ['waiting_for_user_action', 'ready_for_user'].includes(x.status));
        let heading = route === 'tasks' ? 'Command Center · задачи' : route === 'usage-cc' ? 'Command Center · статистика' : route === 'usage-task' ? `${id} · статистика` : `${id} · ${taskLabel({ ...state(), job: jobStatus(profile.filename, id) })}`;
        if (id && route === 'task' && state().snapshot.sandbox) heading += ' · Docker';
        let body, hint;
        if (['tasks', 'task'].includes(route)) {
          const top = Math.max(0, index - contentHeight + 1);
          body = rows.slice(top, top + contentHeight).map((x, i) => clean(`${i + top === index ? '❯' : ' '} ${x.label}`));
          if (!rows.length) body = ['Задач пока нет. Вернитесь в Planner: q.'];
          hint = route === 'tasks' ? 'j/k выбор · Enter открыть · t статистика CC · n новая задача · q чат' : state().status === 'accepted'
            ? 'Enter открыть · r diff · t статистика · u публикация · n новая задача · q назад' : 'Enter открыть · p план · r diff · t статистика · e запрос · a продолжить · s остановить · q назад';
          if (route === 'task') {
            hint = 'Tab live · w весь экран · ' + hint;
            if (width >= 110) {
              const leftWidth = Math.min(48, Math.floor(width * 0.36)), rightWidth = width - leftWidth - 3;
              geometry.leftWidth = leftWidth;
              const stream = visibleStream();
              if (liveFile !== stream?.file) { liveFile = stream?.file; liveScroll = 0; liveFollow = true; }
              const lines = live.render(stream, rightWidth, expandedTools), available = Math.max(1, contentHeight - 2);
              const maxScroll = Math.max(0, lines.length - available);
              liveScroll = liveFollow ? maxScroll : Math.min(liveScroll, maxScroll);
              const right = [theme.fg(liveFocus ? 'accent' : 'muted', `${liveFocus ? '❯ ' : ''}${streamHeading(stream)} · ${liveFollow ? 'live ●' : 'пауза прокрутки'}`),
                theme.fg('muted', `${liveFocus ? 'j/k · колесо' : 'Tab / клик → прокрутка'} · ${liveScroll + 1}/${lines.length}`), ...lines.slice(liveScroll, liveScroll + available)];
              const left = [...body, ...Array(Math.max(0, contentHeight - body.length)).fill('')];
              body = splitLines(left, right, leftWidth, rightWidth, widgets, theme.fg('dim', ' │ '));
              if (liveFocus) hint = 'Tab меню · j/k прокрутка · gg/G · l live · o полный вывод · w весь экран · e запрос · q назад';
            } else if (liveFocus) liveFocus = false;
          }
        } else if (['feedback', 'answer', 'commit-message', 'mr-result', 'knowledge-feedback'].includes(route)) {
          heading = `${id} · ${{ feedback: 'замечания Builder', 'knowledge-feedback': 'замечания к документации', answer: 'команда выполнена вручную: опишите результат', 'commit-message': 'сообщение коммита', 'mr-result': 'созданный MR: введите ID и URL через пробел' }[route]}`;
          body = new widgets.Text(clean(textInput) + '▏', 0, 0).render(width);
          hint = ['commit-message', 'mr-result'].includes(route) ? 'Enter сохранить · Ctrl+u очистить · Esc отменить' : 'Enter отправить и продолжить цикл · Esc отменить';
        } else {
          let source = document;
          if (usageRoute()) { source = usageDocument(readUsage(), route === 'usage-task' ? id : undefined); title = 'Токены и стоимость'; }
          let watched;
          if (route === 'watch') { watched = watchFile ? streams(dir()).find(x => x.file === watchFile) : visibleStream(); title = streamHeading(watched); }
          if (route === 'knowledge') { knowledge = previewKnowledge(profile.filename, id); source = knowledgeDocument(knowledge, knowledgeSelected); }
          if (route === 'checks') {
            title = 'Проверки · живой вывод';
            const kbRoot = path.join(dir(), 'knowledge-update');
            const files = fs.readdirSync(dir()).filter(x => /-check-\d+\.log$|-integration-\d+\.log$/.test(x)).map(x => path.join(dir(), x));
            if (fs.existsSync(kbRoot)) files.push(...fs.readdirSync(kbRoot).filter(x => /^check-\d+\.log$/.test(x)).map(x => path.join(kbRoot, x)));
            source = files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).slice(-20)
              .map(file => `## ${path.relative(dir(), file)}\n\n\`\`\`text\n${tail(file, 24000)}\n\`\`\``).join('\n\n') || 'Ожидаются проверки.';
          }
          if (route === 'journal') source = `${state().error ?? ''}\n\n${commandDocument(dir()).content}` +
            (fs.existsSync(path.join(dir(), 'knowledge-update/commands.jsonl')) ? '\n\n# База знаний\n\n' + commandDocument(path.join(dir(), 'knowledge-update')).content : '');
          if (route === 'docker') source = dockerDocument(dir());
          const lines = route === 'watch' ? live.render(watched, width, expandedTools) : new widgets.Markdown(clean(source), 0, 0, sdk.getMarkdownTheme()).render(width);
          const maxScroll = Math.max(0, lines.length - contentHeight);
          scroll = follow ? maxScroll : Math.min(scroll, maxScroll);
          body = lines.slice(scroll, scroll + contentHeight); heading += ` · ${title} · ${scroll + 1}/${lines.length}`;
          hint = 'j/k · Space/PgDn · gg/G · q назад';
          if (['watch', 'checks'].includes(route)) hint += ` · l live ${follow ? '●' : '○'}`;
          if (route === 'watch') hint += ' · o полный вывод';
          if (route === 'plan') hint += ' · a утвердить этот план и запустить';
          if (route === 'review') hint += ` · e Neovim${review.canFeedback ? ' · f исправить' : ''}${review.canAccept ? ' · a принять результат' : ''}${review.status === 'accepted' ? ' · u публикация' : ''}`;
          if (route === 'publication') hint = `${publication.done ? 'c очистка после merge' : 'Enter ' + (publication.pending ? 'продолжить' : 'опубликовать')}${publication.canEditMessage && !publication.pending ? ' · m сообщение' : ''}${publication.pending ? '' : ' · 1 коммит' + (publication.capabilities.push ? ' · 2 push' : '') + (publication.capabilities.mr ? ' · 3 MR' : '')}${publication.mergeRequest?.status === 'started' ? ' · v MR создан · z проверил: MR отсутствует' : ''} · j/k · q назад`;
          if (route === 'cleanup') hint = 'j/k · Enter удалить показанные worktree · q отменить';
          if (route === 'action') hint = `Enter ${preview ? 'выполнить команду ' + (preview.index + 1) + ' здесь' : 'передать результат'} · d отклонить · x ошибка → Builder · m выполнено вручную · j/k · q назад`;
          if (route === 'recovery') hint += ' · Enter я проверил исходы: возобновить';
          if (route === 'knowledge') hint = knowledge.job?.alive ? 'j/k · s остановить обновление · q назад'
            : ['ready', 'published', 'publication_failed', 'publishing'].includes(knowledge.status) ? `j/k · e Neovim${knowledge.status === 'ready' ? ' · f исправить' : ''} · u публикация базы · q назад`
            : knowledge.status === 'capture_failed' ? 'j/k · c повторить снимок кода · q отложить'
            : knowledge.status === 'empty' ? 'j/k · q назад'
            : knowledge.status === 'awaiting_acceptance' ? 'j/k · q назад: сначала примите код'
            : ['approved', 'failed', 'running'].includes(knowledge.status) ? 'j/k · Enter продолжить Builder базы · q отложить'
            : '1–9 выбрать · Enter одобрить и запустить · d отклонить · j/k · q отложить';
          if (route === 'knowledge-publication') hint = `${knowledgePublication.done ? '' : 'Enter опубликовать · '}${knowledgePublication.pending ? '' : '1 коммит · ' + (knowledgePublication.canPush ? '2 push · ' : '')}j/k · q назад`;
        }
        if (id && ['task', 'review', 'publication', 'archive'].includes(route) && state().snapshot.knowledgeBase) hint += ' · b база знаний';
        const notice = theme.fg(error ? 'error' : 'muted', clean(error || (busy ? 'Выполняется…' : '')).replace(/\s+/g, ' '));
        const footer = shortcutHint(theme, hint, route);
        const output = [theme.fg('accent', clean(heading)), theme.fg('warning', pending.map(x => `${x.id}: ${stageLabel(x.status)}`).join(' · ')), '',
          ...body, ...Array(Math.max(0, contentHeight - body.length)).fill(''), notice, ...new widgets.Text(footer, 0, 0).render(width).slice(0, 2)];
        geometry.height = output.length;
        return output.map(line => widgets.truncateToWidth(line, width));
      },
    };
    const timer = setInterval(() => {
      if (!busy && id && (afterAccept === id || afterPublish === id) && !jobStatus(profile.filename, id)?.alive) {
        afterAccept = false; afterPublish = false;
        if (state().status === 'accepted') void action(async () => { await openPublication(); error = jobStatus(profile.filename, id)?.error ?? ''; });
      }
      redraw();
    }, 750);
    if (['usage-cc', 'usage-task'].includes(initial)) reset(initial);
    else if (selected) { task(); if (initial === 'review') void action(openReview); else if (initial === 'plan') void action(openPlan); }
    pointer.enable();
    return component;
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'center' }, onHandle: handle => { overlayHandle = handle; } }).then(result => { if (result === 'new') return onNew(); });
}
