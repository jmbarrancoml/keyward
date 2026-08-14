// Regenerates the screenshots in the README, so they never drift from the UI.
//
//   npm run shots
//
// Serves the demo database, drives a headless Chromium over each tab in both
// appearances, and records one short clip of the flow the tool exists for.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'assets', 'shots');
const PORT = 7871;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const proc = spawn(process.execPath, ['dist/cli.js', 'ui', '--demo', '--port', String(PORT)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const token = await new Promise((resolve, reject) => {
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const found = /\/\?t=([a-f0-9]+)/.exec(buffer);
      if (found) resolve(found[1]);
    });
    proc.on('exit', () => reject(new Error('the server exited before printing a URL')));
  });
  return { proc, token };
}

/** Trim to 1600px wide: crisp on a normal screen, sane in a git repo. */
function shrink(file) {
  const tmp = file.replace('.png', '.tmp.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'scale=1600:-1', tmp]);
  renameSync(tmp, file);
}

const TABS = [
  ['overview', 'Overview'],
  ['keys', 'Keys'],
  ['contacts', 'Contacts'],
  ['batches', 'Batches'],
  ['sale', 'On sale'],
];

const { proc, token } = await startServer();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1320, height: 840 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    const page = await context.newPage();

    for (const [tab, label] of TABS) {
      await page.goto(`http://127.0.0.1:${PORT}/?t=${token}#${tab}`);
      await page.waitForSelector('.tab[aria-selected="true"]');
      // The tab in the hash is only read on load, so click it as well.
      await page.click(`.tab[data-tab="${tab}"]`);
      await page.waitForTimeout(500);

      const file = join(out, `${tab}-${scheme}.png`);
      await page.screenshot({ path: file });
      shrink(file);
      console.log(`  ${label} (${scheme})`);
    }
    await context.close();
  }

  // One clip of the move the whole tool is built around: you bought a copy off
  // a resale site, and keyward tells you whose key it was.
  const context = await browser.newContext({
    viewport: { width: 1320, height: 840 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    recordVideo: { dir: join(out, 'video'), size: { width: 1320, height: 840 } },
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?t=${token}#overview`);
  await page.waitForSelector('.verdict h2');
  await page.waitForTimeout(1400);

  await page.click('[data-act="trace"]');
  await page.waitForSelector('#f-key');
  await page.waitForTimeout(700);
  await page.type('#f-key', 'XF2JX-YYNNC-JQBWG', { delay: 55 });
  await page.waitForTimeout(500);
  await page.click('[data-act="submit"]');
  await page.waitForSelector('.facts');
  await page.waitForTimeout(2600);

  await context.close();
  const webm = readdirSync(join(out, 'video')).find((f) => f.endsWith('.webm'));
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', join(out, 'video', webm),
    '-vf', 'fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
    join(out, 'trace.gif'),
  ]);
  rmSync(join(out, 'video'), { recursive: true, force: true });
  console.log('  trace.gif');
} finally {
  await browser.close();
  proc.kill();
  await sleep(200);
}
