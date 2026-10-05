import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandDocument, codeBlock } from '../tui/documents.mjs';

function journal(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'commands.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  return dir;
}

test('command journal combines phases, preserves multiline commands and distinguishes failed/unknown outcomes', t => {
  const command = 'ls -R catalog | head -40\ngit status --short';
  const data = { id: 'one', actor: 'builder', kind: 'bash', command, cwd: '/worktree/app', at: '2026-09-16T12:00:00.000Z' };
  const dir = journal(t, [
    { ...data, phase: 'requested' }, { ...data, phase: 'started' },
    { ...data, phase: 'finished', exit_code: 0, duration_ms: 85 },
    { ...data, id: 'two', command: 'bad command', phase: 'finished', status: 'rejected', error: 'Denied by guard' },
    { ...data, id: 'three', command: 'still running', phase: 'started' },
    { ...data, id: 'cut', command: 'output limited', phase: 'finished', exit_code: 0, status: 'output_limit' },
    { ...data, id: 'four', argv: ['python', 'my script.py', "a'b"], command: undefined, phase: 'finished', exit_code: 2 },
  ]);
  const { content } = commandDocument(dir);
  assert.equal(content.split(command).length - 1, 1);
  assert.match(content, /Команд: 5/); assert.match(content, /OK.*builder.*0\.09 с/);
  assert.match(content, /ОТКЛОНЕНО/); assert.match(content, /ПРЕРВАНО · output/); assert.match(content, /исход пока неизвестен/);
  assert.match(content, /ОШИБКА · exit 2/); assert.match(content, /python 'my script.py'/);
  assert(content.indexOf('exit 2') < content.indexOf('OK'));
  assert(!content.includes('id=one')); assert.match(content, /Denied by guard/);
});

test('journal bounds large histories, skips partial records and safely fences embedded Markdown', t => {
  const dir = journal(t, Array.from({ length: 250 }, (_,i) => ({ id: String(i), command: `printf '${i} 日本語'`, phase: 'started' })));
  fs.appendFileSync(path.join(dir, 'commands.jsonl'), 'null\n123\n{"incomplete":');
  const { content } = commandDocument(dir, { limit: 3, maxBytes: 900 });
  assert.match(content, /Команд: 3/); assert.match(content, /Полная история/);
  assert.match(content, /пропущено: 3/); assert(!content.includes('\ufffd'));
  assert(content.includes('249 日本語')); assert(!content.includes('245 日本語'));
  assert.equal(codeBlock('```\n# not a title'), '````\n```\n# not a title\n````');
});
