import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEMO_NOTICE = 'DEMO: фиксированный сценарий. Для своей задачи запустите pi с реальным профилем (--profile).';

// A deterministic provider drives the real pi SDK/tools without network or tokens.
export function demoProvider(ai, { role, stateDir, taskPath, scenario = 'loop', findTask = () => undefined }) {
  return {
    api: 'cc-demo-api', baseUrl: 'https://invalid.example', apiKey: 'local-demo',
    models: [{ id: 'scripted', name: 'CC DEMO (no model calls)', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
          stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
        try {
          if (scenario === `network-${role}-once`) {
            const marker = path.join(stateDir, `.demo-${role}-outage`);
            if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'injected network outage'); throw new Error('Network connection reset (injected demo failure)'); }
          }
          const lastUser = context.messages.findLastIndex(x => x.role === 'user');
          const results = context.messages.slice(lastUser + 1).filter(x => x.role === 'toolResult');
          const used = name => results.some(x => x.toolName === name);
          const state = stateDir && fs.existsSync(path.join(stateDir, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))) : undefined;
          let call, text;
          if (role === 'planner') {
            const taskID = JSON.parse(fs.readFileSync(taskPath, 'utf8')).id;
            const existing = findTask(taskID);
            if (existing) {
              text = `${DEMO_NOTICE}\n\nЗадача ${taskID} уже существует (${existing.status}${existing.delivery?.status === 'done' ? ', опубликована' : ''}). Откройте /tasks для просмотра или продолжения. Повторная подготовка пропущена; сохранённый результат остаётся доступен.`;
            } else if (!used('cc_prepare')) call = ['cc_prepare', { task_path: taskPath }];
            else text = `${DEMO_NOTICE}\n\nПлан подготовлен: обновить app и library, пройти форматирование, линтеры, тесты и ревью. Откройте /tasks, затем p для плана и a для запуска.`;
          } else if (role === 'orchestrator') text = 'Цикл выполняется фоновым контроллером. В /tasks видны исполнители, проверки и запросы. После завершения откройте diff клавишей r.';
          else if (scenario === 'knowledge-update') {
            const file = '/knowledge/' + state.snapshot.knowledgeUpdate.paths[0];
            if (!used('cc_read')) call = ['cc_read', { path: file }];
            else if (!used('cc_write')) {
              const prior = results.find(x => x.toolName === 'cc_read').content.map(x => x.text ?? '').join('');
              call = ['cc_write', { path: file, content: prior.trimEnd() + '\n\n## Reviewed feature\n\nThe task passed its configured checks and review. See the accepted task for the exact code version.\n' }];
            } else text = 'Одобренное описание добавлено в базу. Код проекта сохранён.';
          }
          else if (role === 'explorer') {
            if (!used('cc_read')) call = ['cc_read', { path: 'app/value.txt' }];
            else text = 'app/value.txt содержит значение приложения. library/value.txt — зависимость. Обновить оба файла; источники прочитаны в текущем worktree.';
          } else if (role === 'reviewer') {
            if (!used('cc_read')) call = ['cc_read', { path: 'library/value.txt' }];
            else if (!used('review_submit')) {
              const needsFix = ['loop', 'docker'].includes(scenario) && state.round === 2;
              call = ['review_submit', { verdict: needsFix ? 'changes_requested' : 'approved',
                summary: needsFix ? 'Добавить явный маркер reviewed в библиотеке.' : 'Проверки пройдены; замечаний нет.',
                findings: needsFix ? [{ severity: 'blocking', repository: 'library', path: 'value.txt', reason: 'Отсутствует демонстрационный маркер reviewed.', fix: 'Добавить reviewed, сохранив valid.' }] : [] }];
            } else text = 'Ревью отправлено.';
          } else if (role === 'execution-reviewer') {
            if (!used('execution_submit')) call = ['execution_submit', { request_id: process.env.CC_EXECUTION_REQUEST_ID, verdict: 'deny', task_relevant: false, risk: 'unknown', reason: 'Demo provider cannot assess arbitrary execution.', evidence: ['Scripted provider has no safety reasoning.'] }];
            else text = 'Запуск отклонён.';
          } else {
            const wrote = file => results.some(x => x.toolName === 'cc_write' && context.messages.slice(lastUser + 1).some(m => m.role === 'assistant' && m.content.some(c => c.type === 'toolCall' && c.id === x.toolCallId && c.arguments.path === file)));
            const alreadyRequested = context.messages.some(x => x.role === 'toolResult' && x.toolName === 'request_user_action');
            if (!used('explore')) call = ['explore', { question: 'Inspect app/value.txt and its relationship to library/value.txt.' }];
            else if (!wrote('app/value.txt')) call = ['cc_write', { path: 'app/value.txt', content: ['loop', 'docker'].includes(scenario) && state.round === 1 ? 'valid lint-error\n' : 'valid\n' }];
            else if (!wrote('library/value.txt')) call = ['cc_write', { path: 'library/value.txt', content: state.round >= 3 ? 'valid reviewed\n' : 'valid\n' }];
            else if (scenario === 'docker' && !used('cc_exec')) call = ['cc_exec', { cwd: 'app', argv: ['python', '-c', 'import os,time; print("Builder inside Docker, uid=" + str(os.getuid()), flush=True); time.sleep(2); print("diagnostic complete", flush=True)'], reason: 'Show live Docker output in pi' }];
            else if (!alreadyRequested && scenario === 'loop') call = ['request_user_action', { repo: 'app', title: 'Проверить Node.js', reason: 'Демонстрация выполнения команды в том же терминале.', why_agent_cannot: 'У роли отсутствует произвольный shell.', commands: [{ command: 'node --version', cwd: path.join(state.snapshot.featureRoot, 'app') }], expected_result: 'Номер версии Node.js, exit 0.', risks: 'Команда только выводит версию.' }];
            else if (state.snapshot.knowledgeBase && !used('kb_propose')) call = ['kb_propose', { proposals: [{ id: 'document-feature', title: 'Описать проверенную фичу', paths: ['docs/overview.md'], reason: 'База должна содержать описание проверенного поведения.', evidence: 'app/value.txt и library/value.txt; результаты проверок и Reviewer доступны после завершения.' }] }];
            else text = 'Изменения подготовлены. Если есть запрос пользователя, ожидаю его; затем передаю результат проверкам.';
          }
          const failed = results.find(x => x.isError);
          if (failed) { call = undefined; throw new Error('Demo tool failed: ' + JSON.stringify(failed.content)); }
          stream.push({ type: 'start', partial: message });
          const thought = role === 'planner' ? DEMO_NOTICE : 'Проверяю текущую стадию и результаты инструментов. (Сценарий demo)';
          message.content.push({ type: 'thinking', thinking: thought });
          stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
          stream.push({ type: 'thinking_delta', contentIndex: 0, delta: thought, partial: message });
          stream.push({ type: 'thinking_end', contentIndex: 0, content: thought, partial: message });
          await new Promise(resolve => setTimeout(resolve, 80));
          if (options?.signal?.aborted) throw new Error('aborted');
          if (call) {
            const block = { type: 'toolCall', id: crypto.randomUUID(), name: call[0], arguments: call[1] };
            message.content.push(block); message.stopReason = 'toolUse';
            stream.push({ type: 'toolcall_start', contentIndex: 1, partial: message });
            stream.push({ type: 'toolcall_delta', contentIndex: 1, delta: JSON.stringify(block.arguments), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 1, toolCall: block, partial: message });
          } else {
            message.content.push({ type: 'text', text });
            stream.push({ type: 'text_start', contentIndex: 1, partial: message });
            stream.push({ type: 'text_delta', contentIndex: 1, delta: text, partial: message });
            stream.push({ type: 'text_end', contentIndex: 1, content: text, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = 'error'; message.errorMessage = error.message;
          stream.push({ type: 'error', reason: 'error', error: message });
        }
        stream.end();
      });
      return stream;
    },
  };
}
