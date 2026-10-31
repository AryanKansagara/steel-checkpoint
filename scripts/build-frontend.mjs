import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist'));
for (const name of ['index.html', 'styles.css', 'app.js', 'view-model.js']) {
  await copyFile(resolve(root, 'web', name), resolve(root, 'dist', name));
}
console.log('Built static frontend; API requires configured BACKEND_ORIGIN.');
