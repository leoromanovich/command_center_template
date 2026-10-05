import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupDemo } from './setup-demo.mjs';
import { ROOT } from './lib/pi.mjs';

export async function setupDockerDemo(destination = path.join(ROOT, '.docker-demo')) {
  const f = await setupDemo(destination, 'docker');
  const profile = JSON.parse(fs.readFileSync(f.profile));
  profile.sandbox = { kind: 'docker', image: 'local/cc-sandbox-python:0.1', contextFiles: ['checks.py'] };
  profile.devRun = { enabled: false };
  for (const repo of Object.values(profile.repositories)) {
    repo.checks = Object.fromEntries(['format', 'formatCheck', 'lint', 'test'].map(phase => [phase, [['python', '-I', '/context/checks.py', phase]]]));
  }
  fs.writeFileSync(path.join(f.commandCenter, 'checks.py'), `import pathlib, sys
phase = sys.argv[1]
file = pathlib.Path('value.txt')
text = file.read_text()
if phase == 'format':
    file.write_text(text.strip() + '\\n')
elif phase == 'formatCheck':
    assert text == text.strip() + '\\n', 'Formatting differs'
elif phase == 'lint':
    assert 'lint-error' not in text, 'Demo lint error: remove lint-error'
elif phase == 'test':
    assert 'valid' in text, 'Value must include valid'
print(phase + ': passed', flush=True)
`);
  fs.writeFileSync(f.profile, JSON.stringify(profile, null, 2) + '\n');
  return f;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const f = await setupDockerDemo(process.argv[2]); console.log(f.profile);
}
