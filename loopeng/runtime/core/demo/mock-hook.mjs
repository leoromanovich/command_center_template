import fs from 'node:fs';
import path from 'node:path';
import { git } from '../lib/process.mjs';
const name = process.argv[2];
const resultPath = process.env.CC_RESULT_PATH;
const dir = path.dirname(resultPath);
// Local files only. No HTTP, Jira, push or MR creation.
fs.appendFileSync(path.join(dir, 'mock-hooks.jsonl'), JSON.stringify({ name, key: process.env.CC_IDEMPOTENCY_KEY,
  previous: JSON.parse(process.env.CC_PREVIOUS_HOOK_RESULT), at: new Date().toISOString() }) + '\n');
if (name === 'mergeRequest') for (const id of ['app', 'library']) {
  const repo = path.join(process.env.CC_FEATURE_ROOT, id);
  await git(repo, 'add', '--', 'value.txt', ...(fs.existsSync(path.join(repo, 'new.txt')) ? ['new.txt'] : []));
  await git(repo, 'commit', '--allow-empty', '-m', 'Mock publication');
}
console.log(JSON.stringify({ id: `${name}-demo`, url: `https://example.invalid/${name}/demo` }));
