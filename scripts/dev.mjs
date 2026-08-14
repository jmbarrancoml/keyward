// Dev runner: tsc in watch mode alongside a self-restarting server.
//
// Spawned rather than shell-chained so it works the same on Windows, and so
// both children die with this process instead of being orphaned.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Pinned for the session: `node --watch` restarts the server on every rebuild,
// and a fresh token each time would invalidate the tab you already have open.
const token = randomBytes(24).toString('hex');
const port = process.env.KEYWARD_DEV_PORT ?? '7842';

// Working on the UI against an empty database tells you nothing about how it
// looks with data in it, so --demo is passed straight through.
const demo = process.argv.includes('--demo');

const children = [
  spawn(npx, ['tsc', '-b', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' }),
  spawn(
    process.execPath,
    [
      '--watch',
      '--watch-preserve-output',
      'dist/cli.js',
      'ui',
      '--dev',
      '--port',
      port,
      ...(demo ? ['--demo'] : []),
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, KEYWARD_DEV_TOKEN: token } },
  ),
];

console.log(`\n  http://127.0.0.1:${port}/?t=${token}\n`);
if (demo) console.log('  Serving invented demo data. Your real database is untouched.');
console.log('  Editing src/ui/app.html reloads the page. Editing anything in src/');
console.log('  rebuilds, restarts the server, and reloads the page. Ctrl-C to quit.\n');

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const c of children) c.on('exit', shutdown);
