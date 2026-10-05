import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';

const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const outputText = result => result?.content?.map(x => x.type === 'text' ? x.text : '[image]').join('\n') ?? '';
const safe = value => typeof value === 'string' ? clean(value) : Array.isArray(value) ? value.map(safe)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), safe(v)])) : value;

// Reconstruct display blocks only. No SDK sessions, tools, or model calls are opened.
export function chatBlocks(events) {
  const blocks = [], tools = new Map();
  let activeTool;
  const append = (type, text) => {
    if (blocks.at(-1)?.type === type) blocks.at(-1).text += text;
    else blocks.push({ type, text });
  };
  for (const e of events) {
    if (e.type === 'text_delta' || e.type === 'thinking_delta') append(e.type, e.text ?? '');
    else if (e.type === 'tool') {
      const block = { type: 'tool', id: e.id, name: e.name, args: e.args, output: '', done: false };
      blocks.push(block); tools.set(e.id, block); activeTool = block;
    } else if (e.type === 'tool_result' || e.type === 'tool_update') {
      let block = tools.get(e.id);
      if (!block) { block = { type: 'tool', id: e.id, name: e.name, args: {}, output: '' }; tools.set(e.id, block); blocks.push(block); }
      // cc_exec emits chunk updates; the final result replaces that accumulated output.
      if (e.type === 'tool_update') block.output += outputText(e.result);
      else {
        block.output = outputText(e.result); block.done = true; block.error = e.error;
        if (!e.error && ['review_submit', 'execution_submit'].includes(block.name)) {
          try { if (isDeepStrictEqual(JSON.parse(block.output), block.args)) block.output = '✓ Заключение принято.'; } catch {}
        }
      }
    } else if (e.type === 'docker_output' && !activeTool) append('output', e.text ?? '');
    else if (e.type === 'failed') blocks.push({ type: 'error', text: e.text ?? 'Агент завершился с ошибкой.' });
    else if (e.type === 'finished') blocks.push({ type: 'notice', text: '✓ Сессия завершена' });
    else if (e.type === 'usage') activeTool = undefined;
  }
  return blocks;
}

export function createLiveRenderer({ sdk, widgets, theme, tui, cwd }) {
  let cacheKey, cached = [];
  const preview = (text, count, expanded, fromEnd = false) => {
    const lines = clean(text).split('\n');
    return expanded || lines.length <= count ? lines.join('\n')
      : fromEnd ? `… выше ${lines.length - count} строк · o полный вывод\n` + lines.slice(-count).join('\n')
      : lines.slice(0, count).join('\n') + `\n… ещё ${lines.length - count} строк · o полный вывод`;
  };
  return {
    invalidate() { cacheKey = undefined; },
    render(stream, width, expanded = false) {
      if (!stream) return new widgets.Text('Ожидается запуск агента.\nТекст и команды появятся здесь автоматически.', 0, 0).render(width);
      const key = JSON.stringify([stream.file, stream.events, width, expanded]);
      if (key === cacheKey) return cached;
      const lines = [];
      for (const block of chatBlocks(stream.events)) {
        if (['text_delta', 'thinking_delta'].includes(block.type)) {
          const content = block.type === 'text_delta' ? { type: 'text', text: clean(block.text) } : { type: 'thinking', thinking: clean(block.text) };
          const message = new sdk.AssistantMessageComponent({ role: 'assistant', content: [content], stopReason: 'stop' }, false, sdk.getMarkdownTheme(), 'Размышляет…', 0);
          // Native shell-integration markers describe full-width rows, not a split pane.
          lines.push(...message.render(width).map(line => line.replace(/\x1b\]133;[ABC]\x07/g, '')));
        } else if (block.type === 'tool') {
          const tool = new sdk.ToolExecutionComponent(clean(block.name), clean(block.id), safe(block.args), { showImages: false }, {
            renderCall: args => new widgets.Text(theme.fg('toolTitle', clean(block.name)) + '\n' + preview(JSON.stringify(args, null, 2), 8, expanded), 0, 0),
            renderResult: result => new widgets.Text(preview(outputText(result), 12, expanded, true), 0, 0),
          }, tui, cwd);
          if (block.done || block.output) tool.updateResult({ content: [{ type: 'text', text: clean(block.output) }], isError: !!block.error }, !block.done);
          lines.push('', ...tool.render(width));
        } else lines.push('', ...new widgets.Text(theme.fg(block.type === 'error' ? 'error' : 'muted', clean(block.text)), 0, 0).render(width));
      }
      cacheKey = key; cached = lines.length ? lines : ['Агент подключается к модели…'];
      return cached;
    },
  };
}

export function splitLines(left, right, leftWidth, rightWidth, widgets, separator) {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    const line = widgets.truncateToWidth(left[i] ?? '', leftWidth);
    return line + ' '.repeat(Math.max(0, leftWidth - widgets.visibleWidth(line))) + separator + widgets.truncateToWidth(right[i] ?? '', rightWidth);
  });
}
