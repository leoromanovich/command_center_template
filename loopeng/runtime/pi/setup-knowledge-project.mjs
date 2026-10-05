import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/pi.mjs';
import { setupDockerProject } from './setup-docker-project.mjs';
import { git } from '../core/lib/process.mjs';

// Only used for newly authored examples/tests. Never attach to an existing user's CC.
export async function attachExampleKnowledge(f) {
  const cc = f.commandCenter, source = path.join(f.base, 'knowledge-origin');
  if (fs.existsSync(path.join(cc, '.git')) || fs.existsSync(source)) throw new Error('Knowledge example requires a fresh Command Center');
  fs.mkdirSync(path.join(source, 'docs'), { recursive: true });
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'Knowledge Example'); await git(source, 'config', 'user.email', 'example@invalid.test');
  fs.writeFileSync(path.join(source, 'docs/overview.md'), '# Project knowledge\n\nThis is a small local example. Update only reviewed, evidence-backed documentation.\n');
  fs.writeFileSync(path.join(source, 'policy.txt'), 'This file is outside the permitted documentation directory.\n');
  await git(source, 'add', '--', '.'); await git(source, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Initial knowledge');
  await git(cc, 'init', '-b', 'main'); await git(cc, 'config', 'user.name', 'Command Center Example'); await git(cc, 'config', 'user.email', 'example@invalid.test');
  await git(cc, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'knowledge');
  const submodule = path.join(cc, 'knowledge');
  await git(submodule, 'config', 'user.name', 'Knowledge Example'); await git(submodule, 'config', 'user.email', 'example@invalid.test');
  fs.appendFileSync(path.join(cc, '.gitignore'), '\n/.pi/cc-profile.json\n/.pi/cc-plans/\n/start\n');
  fs.appendFileSync(path.join(cc, 'AGENTS.md'), '\nKnowledge lives in the knowledge/ Git submodule. It is read-only during implementation. Builder may propose optional updates to docs/*.md via kb_propose. The user separately approves a later Builder run and reviews/publishes its KB diff. Code acceptance and publication never require a KB update.\n');
  fs.mkdirSync(path.join(cc, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(cc, 'checks/knowledge.py'), `from pathlib import Path
import sys

for file in Path(sys.argv[1]).rglob('*.md'):
    text = file.read_text(encoding='utf-8')
    assert text.startswith('# '), f'{file}: missing title'
    assert text.endswith('\\n'), f'{file}: missing final newline'
    assert '\\x00' not in text, f'{file}: binary data'
print('Knowledge Markdown checks passed')
`);
  await git(cc, 'add', '--', '.gitignore', '.gitmodules', 'AGENTS.md', 'checks', 'knowledge');
  await git(cc, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Pin knowledge submodule and checks');
  const profile = JSON.parse(fs.readFileSync(f.profile, 'utf8'));
  profile.knowledgeBase = { submodule: 'knowledge', writablePaths: ['docs'], checks: [['python', '-I', '/context/checks/knowledge.py', '/knowledge/docs']] };
  profile.sandbox.contextFiles.push('checks/knowledge.py');
  fs.writeFileSync(f.profile, JSON.stringify(profile, null, 2) + '\n');
  return { ...f, knowledgeSource: submodule, knowledgeOrigin: source };
}
export async function setupKnowledgeProject(destination = path.join(ROOT, '.knowledge-project')) {
  return attachExampleKnowledge(await setupDockerProject(destination));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const f = await setupKnowledgeProject(process.argv[2]); console.log(`cd ${f.commandCenter}\n./start`);
}
