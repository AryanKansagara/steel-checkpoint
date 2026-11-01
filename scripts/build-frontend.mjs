import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist'));
for (const name of [ 'styles.css', 'app.js', 'view-model.js']) {
  await copyFile(resolve(root, 'web', name), resolve(root, 'dist', name));
}
await mkdir(resolve(root, 'dist', 'app'), { recursive: true });
await copyFile(resolve(root, 'web', 'index.html'), resolve(root, 'dist', 'app.html'));
await copyFile(resolve(root, 'web', 'index.html'), resolve(root, 'dist', 'app', 'index.html'));
await copyFile(resolve(root, 'web', 'landing.html'), resolve(root, 'dist', 'index.html'));
for (const name of ['landing.css', 'landing.js']) await copyFile(resolve(root, 'web', name), resolve(root, 'dist', name));
console.log('Built static frontend; private product API uses the native JSON relay.');
