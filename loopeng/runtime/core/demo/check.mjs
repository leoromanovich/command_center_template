import fs from 'node:fs';
const phase = process.argv[2];
const text = fs.readFileSync('value.txt', 'utf8');
if (phase === 'format') fs.writeFileSync('value.txt', text.trim() + '\n');
else if (phase === 'formatCheck' && text !== text.trim() + '\n') throw new Error('Formatting differs');
else if (phase === 'lint' && text.includes('lint-error')) throw new Error('Demo lint error: replace lint-error with valid');
else if (phase === 'test' && !text.includes('valid')) throw new Error('Demo test: value must include valid');
console.log(`${phase}: passed`);
