import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('worker/index.js', root);
const manifest = JSON.parse(await readFile(new URL('.openai/hosting.json', root), 'utf8'));
if (!manifest.project_id || manifest.static || manifest.d1 !== 'DB') {
  throw new Error('Expected the existing D1-backed Worker hosting configuration');
}
execFileSync(process.execPath, ['--check', fileURLToPath(source)], { stdio: 'inherit' });
const directory = new URL('dist/server/', root);
await mkdir(directory, { recursive: true });
await copyFile(source, new URL('index.js', directory));
console.log('Worker build ready: dist/server/index.js');
