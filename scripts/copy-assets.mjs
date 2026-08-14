// tsc only emits JS, so the UI's single HTML file is copied alongside it.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, 'dist', 'ui'), { recursive: true });
copyFileSync(join(root, 'src', 'ui', 'app.html'), join(root, 'dist', 'ui', 'app.html'));
