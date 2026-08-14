// One user journey through the whole application, driven in a real browser.
//
//   npm run e2e
//
// It starts at an empty database and ends with an encrypted one, touching every
// tab, dialog, table and endpoint on the way. Nothing is mocked: the server is
// the real one, the database is a real file, and the only thing missing is the
// network keyward would use for Steamworks and IsThereAnyDeal, which is the
// point of the two steps that check those failures read well.
//
// A failing step does not stop the run. Finishing the journey and reporting
// every fault at once beats fixing them one restart at a time.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'keyward-e2e-'));
const DB = join(work, 'journey.db');

const results = [];
const faults = [];
let current = 'start-up';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  current = name;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started });
    faults.push({ where: name, what: e.message.split('\n')[0] });
  }
}

/** Something wrong that did not throw: a wrong count, a leaked value, a stall. */
function fault(what) {
  faults.push({ where: current, what });
}

function check(condition, what) {
  if (!condition) fault(what);
}

/* ---------- the server under test ---------- */

async function startServer(extra = []) {
  const proc = spawn(process.execPath, ['dist/cli.js', 'ui', '--db', DB, '--port', '0', ...extra], {
    cwd: root,
    env: { ...process.env, HOME: work, USERPROFILE: work },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });

  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the server never printed a URL')), 20000);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const found = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/.exec(buffer);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
  return { proc, url, port: Number(new URL(url).port), token: new URL(url).searchParams.get('t') };
}

const cli = (...args) =>
  execFileSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: root,
    env: { ...process.env, HOME: work, USERPROFILE: work },
    encoding: 'utf8',
  });

/* ---------- talking to the page ---------- */

const KEYS = (n, prefix) =>
  Array.from({ length: n }, (_, i) => {
    const body = String(i).padStart(5, '0');
    return `${prefix}-${body}-ZZZZZ`;
  });

async function newPage(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1320, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => fault(`uncaught in the page: ${e.message}`));
  page.on('console', (m) => {
    // Several steps ask for something invalid on purpose, and the browser logs
    // every 4xx as a console error. Those are asserted on where they happen.
    const text = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(text)) {
      fault(`console error: ${text.slice(0, 160)}`);
    }
  });
  page.on('requestfailed', (r) => {
    // A page that reaches the network at all is a bug: the CSP says default-src 'none'.
    if (!r.url().startsWith('http://127.0.0.1')) fault(`the page tried to reach ${r.url()}`);
  });
  await page.goto(url);
  await ready(page);
  return { context, page };
}

/** The shell has drawn something: either a game, or the empty state. */
const ready = (page) =>
  page.waitForFunction(() => (document.getElementById('main')?.innerText ?? '').trim().length > 20, null, { timeout: 20000 });

const dlgOpen = (page) => page.evaluate(() => document.getElementById('dlg')?.open === true);
const dlgError = (page) =>
  page.evaluate(() => {
    const box = document.getElementById('dlg-error');
    return box && !box.hidden ? box.textContent : null;
  });

/** Fills a dialog's fields by id and submits it. */
async function fill(page, values) {
  for (const [id, value] of Object.entries(values)) {
    await page.waitForSelector(`#${id}`, { timeout: 5000 });
    await page.fill(`#${id}`, value);
  }
}

/** Submits, then waits for the dialog to either close or say why it did not. */
async function submit(page) {
  await page.click('[data-act="submit"]');
  await page
    .waitForFunction(() => {
      const dlg = document.getElementById('dlg');
      if (dlg?.open !== true) return true;
      const err = document.getElementById('dlg-error');
      if (err && !err.hidden) return true;
      // trace, revoke and hand-out replace the form with their answer and stay
      // open on purpose. No submit button left means it has answered.
      return dlg.querySelector('[data-act="submit"]') === null;
    }, null, { timeout: 15000 })
    .catch(() => fault('the dialog neither closed, answered, nor said what was wrong'));
  await sleep(250);
}

async function openDialog(page, act) {
  await page.click(`[data-act="${act}"]`);
  await page.waitForSelector('#dlg[open]', { timeout: 5000 });
}

async function closeDialog(page) {
  if (await dlgOpen(page)) {
    await page.click('[data-act="cancel"]');
    await sleep(200);
  }
}

/** Adding a game selects it, so the journey has to say which one it means. */
async function selectGame(page, name) {
  await page.click(`[data-act="select"][data-game="${name.replace(/"/g, '\\"')}"]`);
  await sleep(500);
}

async function tab(page, id) {
  await page.click(`[data-act="tab"][data-tab="${id}"]`);
  await sleep(350);
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
// A closed <dialog> keeps its contents in the DOM, and one of them is a table.
// Anything counting rows has to be scoped to the view or it counts those too.
const rows = (page) => page.locator('#view tbody tr');
const rowCount = (page) => rows(page).count();
const firstColumn = (page) => rows(page).locator('td:first-child').allInnerTexts();

/* ================= the journey ================= */

const browser = await chromium.launch();
let server = await startServer();
let { context, page } = await newPage(browser, server.url);

/* ---------- Act 1: a cold start ---------- */

await step('a wrong token is refused', async () => {
  const bad = await context.request.get(`http://127.0.0.1:${server.port}/?t=${'0'.repeat(48)}`);
  check([401, 403].includes(bad.status()), `a wrong token got ${bad.status()}`);
  const none = await context.request.get(`http://127.0.0.1:${server.port}/api/state`);
  check([401, 403].includes(none.status()), `no token at all got ${none.status()}`);
  const body = await bad.text();
  check(!/token|secret/i.test(body.slice(0, 400)) || body.length < 400,
    'the refusal page says more than it needs to');
});

await step('an empty database says what to do first', async () => {
  const text = await bodyText(page);
  check(/add a game|first game|no games/i.test(text), `the empty state reads: ${text.slice(0, 120)}`);
  check(await page.locator('[data-act="add-game"]').count() > 0, 'no way to add the first game');
});

/* ---------- Act 2: setting up ---------- */

await step('a game can be added', async () => {
  const started = Date.now();
  await openDialog(page, 'add-game');
  await fill(page, { 'f-name': 'Lanternfall', 'f-appid': '2417830' });
  await page.click('[data-act="submit"]');
  await page.waitForFunction(() => document.getElementById('dlg')?.open !== true, null, { timeout: 20000 })
    .catch(() => fault(`the add-game dialog never closed: ${''}`));
  const took = Date.now() - started;
  check(took < 12000, `adding a game took ${took}ms, most of it fetching artwork`);
  await page.waitForFunction(() => document.body.innerText.includes('Lanternfall'), null, { timeout: 8000 })
    .catch(() => fault('the game never appeared in the sidebar'));
});

await step('the same game twice is refused inside the dialog', async () => {
  await openDialog(page, 'add-game');
  await fill(page, { 'f-name': 'Lanternfall' });
  await submit(page);
  check(await dlgOpen(page), 'the dialog closed on a duplicate name');
  const err = await dlgError(page);
  check(err && /already/i.test(err), `the message reads: ${err}`);
  await closeDialog(page);
});

await step('a name full of markup is escaped, not run', async () => {
  const hostile = '<img src=x onerror="window.__pwned=1">Ghost & "Co"';
  await openDialog(page, 'add-game');
  await fill(page, { 'f-name': hostile });
  await submit(page);
  await closeDialog(page);
  check(!(await page.evaluate(() => window.__pwned)), 'a game name executed script in the page');
  const shown = await page.evaluate(() => document.body.innerText);
  check(shown.includes('Ghost & "Co"'), 'the escaped name is not shown as typed');
  check(await page.locator('#games img[src="x"]').count() === 0, 'the markup became an element');
  // Adding a game selects it. Everything after this belongs to Lanternfall.
  await selectGame(page, 'Lanternfall');
});

await step('batches are created, and named once', async () => {
  await tab(page, 'batches');
  await openDialog(page, 'new-batch');
  await fill(page, { 'f-batch-name': 'press', 'f-batch-note': 'launch preview' });
  await submit(page);
  check(!(await dlgOpen(page)), `press was refused: ${await dlgError(page)}`);

  await openDialog(page, 'new-batch');
  await fill(page, { 'f-batch-name': 'press' });
  await submit(page);
  check(await dlgOpen(page), 'a duplicate batch name was accepted');
  await closeDialog(page);
});

await step('keys import from pasted text', async () => {
  await openDialog(page, 'import-keys');
  await fill(page, { 'f-batch': 'press', 'f-text': KEYS(40, 'AAAAA').join('\n') });
  await submit(page);
  await sleep(600);
  const text = await bodyText(page);
  check(/40/.test(text), `40 keys should be visible somewhere: ${text.slice(0, 200)}`);
});

await step('importing the same file twice changes nothing', async () => {
  await openDialog(page, 'import-keys');
  await fill(page, { 'f-batch': 'press', 'f-text': KEYS(40, 'AAAAA').join('\n') });
  await submit(page);
  await sleep(500);
  await closeDialog(page);
  const { total } = await page.evaluate(async () => {
    const r = await fetch(`/api/keys?game=Lanternfall&limit=1&t=${new URL(location.href).searchParams.get('t')}`);
    return r.json();
  });
  check(total === 40, `after importing twice there are ${total} keys, not 40`);
});

await step('text with no keys in it says what came close', async () => {
  await openDialog(page, 'import-keys');
  await fill(page, { 'f-batch': 'press', 'f-text': 'here you go: ABCD-EFGH-IJKL and thanks' });
  await submit(page);
  const err = await dlgError(page);
  check(err && /came close|no keys/i.test(err), `it said: ${err}`);
  await closeDialog(page);
});

await step('keys buried in prose and in lower case are found', async () => {
  await openDialog(page, 'import-keys');
  await fill(page, {
    'f-batch': 'creators',
    'f-text': 'Hi! Here are the two:\n  * bbbbb-00001-zzzzz (for the stream)\n  * BBBBB-00002-ZZZZZ\nThanks!',
  });
  await submit(page);
  await sleep(500);
  await closeDialog(page);
  const rows = await page.evaluate(async () => {
    const t = new URL(location.href).searchParams.get('t');
    const r = await fetch(`/api/keys?game=Lanternfall&q=BBBBB&limit=10&t=${t}`);
    return (await r.json()).rows;
  });
  check(rows.length === 2, `found ${rows.length} of the 2 keys in that message`);
  check(rows.every((r) => r.key === r.key.toUpperCase()), 'a key was stored in lower case');
});

await step('a zip straight from Steamworks imports', async () => {
  const { makeZip } = await import(join(root, 'test', 'helpers', 'zip.js'));
  const file = join(work, 'steamworks.zip');
  writeFileSync(file, makeZip({ 'keys.txt': KEYS(12, 'CCCCC').join('\r\n') }));

  await openDialog(page, 'import-keys');
  await page.fill('#f-batch', 'distributor-halcyon');
  await page.setInputFiles('#f-file', file);
  await sleep(300);
  await submit(page);
  await sleep(700);
  check(!(await dlgOpen(page)), `the zip was refused: ${await dlgError(page)}`);
});

await step('contacts import from a CSV', async () => {
  await tab(page, 'contacts');
  await openDialog(page, 'import-recipients');
  await fill(page, {
    'f-text': 'name,email,kind,handle\nPixel Ledger,hi@example.com,press,pixelledger\n' +
      'Halcyon Distribution,,distributor,\nMara Vex,mara@example.com,creator,maravex',
  });
  await submit(page);
  await sleep(500);
  check(!(await dlgOpen(page)), `the CSV was refused: ${await dlgError(page)}`);
});

/* ---------- Act 3: handing keys out ---------- */

await step('a key is handed out and the batch picker is honoured', async () => {
  await tab(page, 'keys');
  await openDialog(page, 'assign');
  const picker = await page.locator('#f-batch-pick').count();
  check(picker === 1, 'no batch picker with three batches in stock');
  await page.fill('#f-recipient', 'Pixel Ledger');
  const isSelect = await page.locator('select#f-batch-pick').count();
  check(isSelect === 1, 'the batch picker is not a list, so a batch cannot be chosen');
  if (isSelect) await page.selectOption('#f-batch-pick', 'distributor-halcyon');
  await page.fill('#f-campaign', 'launch');
  await submit(page);
  await sleep(500);

  const rows = await page.evaluate(async () => {
    const t = new URL(location.href).searchParams.get('t');
    const r = await fetch(`/api/keys?game=Lanternfall&q=Pixel&limit=5&t=${t}`);
    return (await r.json()).rows;
  });
  check(rows.length === 1, `Pixel Ledger holds ${rows.length} keys, not 1`);
  check(rows[0]?.batch === 'distributor-halcyon',
    `the key came from ${rows[0]?.batch}, not the batch that was picked`);
  await closeDialog(page);
});

await step('every imported contact can be given a key', async () => {
  for (const who of ['Halcyon Distribution', 'Mara Vex']) {
    await openDialog(page, 'assign');
    await page.fill('#f-recipient', who);
    await submit(page);
    const err = await dlgError(page);
    check(!err, `handing a key to ${who} failed: ${err}`);
    await closeDialog(page);
  }
});

await step('handing out to a new name creates the contact', async () => {
  await openDialog(page, 'assign');
  await page.fill('#f-recipient', 'Somebody New');
  await submit(page);
  await sleep(500);
  await closeDialog(page);
  await tab(page, 'contacts');
  check((await bodyText(page)).includes('Somebody New'), 'the new contact is not in the table');
});

await step('a batch with nothing left says so', async () => {
  // Drain the small batch, then ask for one more.
  for (let i = 0; i < 12; i += 1) {
    await page.evaluate(async () => {
      const t = new URL(location.href).searchParams.get('t');
      await fetch(`/api/assign?t=${t}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game: 'Lanternfall', recipient: 'Bulk Taker', batch: 'distributor-halcyon' }),
      });
    });
  }
  const answer = await page.evaluate(async () => {
    const t = new URL(location.href).searchParams.get('t');
    const r = await fetch(`/api/assign?t=${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'Lanternfall', recipient: 'One Too Many', batch: 'distributor-halcyon' }),
    });
    return { status: r.status, body: await r.text() };
  });
  check(answer.status >= 400, `an empty batch answered ${answer.status}`);
  check(/no unused keys left in .{1,2}distributor-halcyon/i.test(answer.body),
    `an empty batch should be named, and it said: ${answer.body.slice(0, 160)}`);
  check(/still available/i.test(answer.body), 'it did not say which batches still have keys');
});

/* ---------- Act 4: looking at it ---------- */

await step('every tab renders', async () => {
  for (const id of ['overview', 'keys', 'contacts', 'batches', 'sale']) {
    await tab(page, id);
    const selected = await page.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
    check(selected === id, `clicking ${id} selected ${selected}`);
    const text = await bodyText(page);
    check(text.trim().length > 40, `${id} rendered almost nothing`);
    check(!/undefined|NaN|\[object Object\]/.test(text), `${id} shows a placeholder value`);
  }
});

await step('every key filter answers', async () => {
  await tab(page, 'keys');
  for (const filter of ['all', 'redeemed', 'waiting', 'unchecked', 'unassigned']) {
    await page.click(`[data-act="filter"][data-filter="${filter}"]`);
    await sleep(300);
    const pressed = await page.getAttribute(`[data-act="filter"][data-filter="${filter}"]`, 'aria-pressed');
    check(pressed === 'true', `${filter} did not light up`);
  }
  await page.click('[data-act="filter"][data-filter="all"]');
  await sleep(300);
});

await step('every column sorts, both ways', async () => {
  await tab(page, 'keys');
  const before = await rowCount(page);
  for (const column of await page.locator('th.sortable').evaluateAll((ths) => ths.map((t) => t.dataset.sort))) {
    for (const pass of [1, 2]) {
      await page.click(`th.sortable[data-sort="${column}"]`);
      await sleep(320);
      const after = await rowCount(page);
      check(after === before, `sorting by ${column} (${pass}) changed the row count ${before} to ${after}`);
    }
  }
});

await step('search finds a person, a batch and a key', async () => {
  await tab(page, 'keys');
  for (const [term, atLeast] of [['Pixel', 1], ['press', 1], ['AAAAA-00003', 1]]) {
    await page.fill('#key-search', term);
    await sleep(600);
    const n = await rowCount(page);
    check(n >= atLeast, `searching ${term} returned ${n} rows`);
  }
  await page.fill('#key-search', 'nothing-matches-this');
  await sleep(600);
  check((await bodyText(page)).includes('Nothing matches'), 'an empty result says nothing useful');
  await page.click('[data-act="clear-all"]');
  await sleep(400);
});

await step('a LIKE wildcard in the search box is a literal', async () => {
  // % and _ mean something to SQL. Typing one should not quietly match everything.
  await tab(page, 'keys');
  const all = await page.evaluate(async () => {
    const t = new URL(location.href).searchParams.get('t');
    return (await (await fetch(`/api/keys?game=Lanternfall&limit=1&t=${t}`)).json()).total;
  });
  for (const wildcard of ['%', '_']) {
    const hit = await page.evaluate(async (w) => {
      const t = new URL(location.href).searchParams.get('t');
      const r = await fetch(`/api/keys?game=Lanternfall&q=${encodeURIComponent(w)}&limit=1&t=${t}`);
      return (await r.json()).total;
    }, wildcard);
    check(hit !== all || all === 0,
      `searching "${wildcard}" returned every one of the ${all} keys, so it is being read as SQL`);
  }
});

await step('clicking a value in the table filters by it', async () => {
  await tab(page, 'keys');
  const drill = page.locator('[data-act="drill"]').first();
  if (await drill.count() === 0) { fault('nothing in the keys table is clickable to filter'); return; }
  const value = (await drill.getAttribute('data-q')) ?? '';
  await drill.click();
  await sleep(600);
  const search = await page.inputValue('#key-search');
  check(search === value, `clicking ${value} put "${search}" in the search box`);
  // "Clear the filters" only exists while nothing matches. Clicking blind here
  // waited out the full timeout and hid it behind a catch.
  await page.click('[data-act="clear-filter"], [data-act="clear-q"]').catch(() => {});
  await page.fill('#key-search', '');
  await sleep(400);
  check((await rowCount(page)) > 1, 'clearing the filter did not bring the rest back');
});

await step('a key is masked until asked for, then copies', async () => {
  await tab(page, 'keys');
  const chip = page.locator('#view td .keychip').first();
  const masked = await chip.innerText();
  check(!/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/m.test(masked),
    `a whole key is on screen without asking: ${masked.split('\n')[0]}`);

  await page.click('[data-act="copy-key"]');
  await sleep(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(clip), `the clipboard holds "${clip}"`);
});

await step('the key menu offers everything it should', async () => {
  await tab(page, 'keys');
  await page.click('[data-act="key-menu"]');
  await page.waitForSelector('.menu[role="menu"]', { timeout: 5000 });
  for (const act of ['copy-key', 'key-reveal', 'key-record', 'key-sighted', 'key-revoke']) {
    check(await page.locator(`.menu [data-act="${act}"]`).count() > 0, `the menu has no ${act}`);
  }
  const steamLink = await page.locator('.menu a[href*="partner.steamgames.com"]').count();
  check(steamLink === 1, 'the menu does not link the key into Steamworks');

  await page.click('.menu [data-act="key-reveal"]');
  await sleep(400);
  const revealed = await page.locator('#view td .keychip').first().innerText();
  check(/[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/.test(revealed), `revealing showed: ${revealed}`);

  await page.click('[data-act="key-menu"]');
  await page.waitForSelector('.menu[role="menu"]');
  await page.click('.menu [data-act="key-record"]');
  await sleep(600);
  check(await dlgOpen(page), '"show what we know" opened nothing');
  await closeDialog(page);
});

await step('contacts and batches sort and search too', async () => {
  await tab(page, 'contacts');
  const contacts = await rowCount(page);
  check(contacts >= 4, `only ${contacts} contacts hold keys, expected at least 4`);
  for (const column of await page.locator('th.sortable').evaluateAll((t) => t.map((x) => x.dataset.sort))) {
    await page.click(`th.sortable[data-sort="${column}"]`);
    await sleep(250);
    check(await rowCount(page) === contacts, `sorting contacts by ${column} changed the count`);
  }
  await page.fill('#contact-search', 'Pixel');
  await sleep(600);
  const narrowed = await firstColumn(page);
  check(narrowed.length === 1, `searching contacts for Pixel left ${narrowed.length}: ${narrowed.join(' | ').slice(0, 120)}`);
  await page.click('[data-act="clear-contact-q"]');
  await sleep(300);

  await tab(page, 'batches');
  const names = await firstColumn(page);
  const batches = names.length;
  check(batches === 3, `${batches} batches: ${names.map((n) => n.split('\n')[0]).join(', ')}`);
  for (const column of await page.locator('th.sortable').evaluateAll((t) => t.map((x) => x.dataset.sort))) {
    await page.click(`th.sortable[data-sort="${column}"]`);
    await sleep(250);
    check(await rowCount(page) === batches, `sorting batches by ${column} changed the count`);
  }
});

await step('a whole list goes out in one go, with a CSV back', async () => {
  await tab(page, 'contacts');
  await openDialog(page, 'handout');
  await fill(page, {
    'f-text': 'name,email,kind\nRuth Marlow,ruth@example.com,press\nTeo Sand,teo@example.com,creator',
    'f-campaign': 'launch',
  });
  await submit(page);

  const heading = await page.locator('#dlg h3').innerText();
  check(/2 handed out/.test(heading), `the hand-out said: ${heading}`);
  const csv = await page.getAttribute('#dlg a[download]', 'href');
  check(Boolean(csv), 'no CSV came back from handing out a list');
  const decoded = decodeURIComponent((csv ?? '').replace(/^data:text\/csv;charset=utf-8,/, ''));
  check(decoded.startsWith('key,name,email'), `the CSV starts: ${decoded.slice(0, 40)}`);
  check(/ruth@example\.com/.test(decoded) && /teo@example\.com/.test(decoded),
    'the CSV lost one of the people');
  const keys = decoded.trim().split('\n').slice(1).map((l) => l.split(',')[0]);
  check(new Set(keys).size === keys.length, 'two people were given the same key');
  await closeDialog(page);
});

await step('the follow-up list names only checked keys', async () => {
  await tab(page, 'contacts');
  await page.click('[data-act="remind"]');
  await page.waitForSelector('#dlg[open]');
  const empty = await page.locator('#dlg h3').innerText();
  check(/nobody to chase/i.test(empty), `with nothing checked it said: ${empty}`);
  await closeDialog(page);
});

await step('a region-locked batch and a sighting elsewhere', async () => {
  await tab(page, 'batches');
  await openDialog(page, 'new-batch');
  await fill(page, { 'f-batch-name': 'latam', 'f-batch-region': 'MX' });
  await submit(page);
  await closeDialog(page);

  const region = await page.locator('#view tbody tr').filter({ hasText: 'latam' }).innerText();
  check(/MX/.test(region), `the batch row reads: ${region.replace(/\n/g, ' ')}`);

  // Put a key in it, hand it out, and find it on sale in the wrong country.
  await page.evaluate(async () => {
    const t = new URL(location.href).searchParams.get('t');
    const post = (path, body) => fetch(`${path}?t=${t}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await post('/api/import/keys', { game: 'Lanternfall', batch: 'latam', text: 'MMMMM-00001-ZZZZZ' });
    await post('/api/assign', { game: 'Lanternfall', recipient: 'Halcyon', batch: 'latam' });
    await fetch(`/api/trace?key=MMMMM-00001-ZZZZZ&seenOn=Kinguin&country=ES&t=${t}`);
  });
  // Writes made outside the page do not redraw it, and switching tabs reuses
  // the report already in hand. A reload is what a person would do too.
  await page.reload();
  await ready(page);
  await selectGame(page, 'Lanternfall');
  await tab(page, 'overview');
  const text = await bodyText(page);
  check(/locked to MX, found on sale in ES/.test(text),
    'the region rule did not fire after a sighting in another country');
});

/* ---------- Act 5: the move it exists for ---------- */

await step('tracing a key names the person it went to', async () => {
  await tab(page, 'keys');
  await openDialog(page, 'trace');
  await fill(page, { 'f-key': 'CCCCC-00000-ZZZZZ', 'f-shop': 'Instant Gaming' });
  await submit(page);
  await sleep(600);
  const text = await bodyText(page);
  check(/Pixel Ledger|Bulk Taker/.test(text), `the trace named nobody: ${text.slice(0, 200)}`);
  await closeDialog(page);
});

await step('tracing a key that is not yours says so', async () => {
  await openDialog(page, 'trace');
  await fill(page, { 'f-key': 'QQQQQ-QQQQQ-QQQQQ' });
  await submit(page);
  await sleep(500);
  const text = (await bodyText(page)) + (await dlgError(page) ?? '');
  check(/not (one of )?your|no such|never|unknown/i.test(text),
    `an unknown key produced: ${text.slice(0, 160)}`);
  await closeDialog(page);
});

await step('a key that is not a key is refused before it is looked up', async () => {
  await openDialog(page, 'trace');
  await fill(page, { 'f-key': 'nonsense' });
  await submit(page);
  await sleep(400);
  check(await dlgOpen(page), 'a malformed key closed the dialog as if it worked');
  const err = await dlgError(page);
  check(err && err.length > 0, 'nothing said why it was refused');
  await closeDialog(page);
});

await step('a key can be recorded as seen for sale, and revoked', async () => {
  await tab(page, 'keys');
  await page.click('[data-act="key-menu"]');
  await sleep(250);
  if (await page.locator('[data-act="key-sighted"]').count()) {
    await page.click('[data-act="key-sighted"]');
    await page.waitForSelector('#f-shop');
    await fill(page, { 'f-shop': 'Kinguin' });
    await submit(page);
    await sleep(400);
    await closeDialog(page);
  } else {
    fault('the key menu offers no way to record a sighting');
  }

  await page.click('[data-act="key-menu"]');
  await sleep(250);
  if (await page.locator('[data-act="key-revoke"]').count()) {
    await page.click('[data-act="key-revoke"]');
    await page.waitForSelector('#f-why');
    await fill(page, { 'f-why': 'found on Kinguin' });
    await submit(page);
    await sleep(500);
    const link = await page.locator('#dlg a[href*="partner.steamgames.com"]').count();
    check(link > 0, 'revoking did not offer the Steamworks page to do it on');
    await closeDialog(page);
  } else {
    fault('the key menu offers no way to revoke');
  }
});

await step('a contact can be renamed, and merged into another', async () => {
  await tab(page, 'contacts');
  await page.click('[data-act="rename-contact"]');
  await page.waitForSelector('#f-contact-to');
  await fill(page, { 'f-contact-to': 'Pixel Ledger' });
  await submit(page);
  await sleep(600);
  check(!(await dlgOpen(page)), `the rename was refused: ${await dlgError(page)}`);
  const names = await firstColumn(page);
  const dupes = names.filter((n) => n.includes('Pixel Ledger')).length;
  check(dupes <= 1, `Pixel Ledger appears ${dupes} times after a merge`);
});

/* ---------- Act 6: the outside world, which is not there ---------- */

await step('a bad IsThereAnyDeal key is refused and the dialog stays put', async () => {
  await tab(page, 'sale');
  await page.click('[data-act="scan"]');
  await page.waitForSelector('#f-itad', { timeout: 8000 });
  await fill(page, { 'f-itad': 'obviously-not-a-key', 'f-country': 'ES' });
  await submit(page);
  await sleep(1200);
  check(await dlgOpen(page), 'a rejected API key closed the dialog');
  const err = await dlgError(page);
  check(err && err.length > 0, 'nothing explained why the key was refused');
  await closeDialog(page);
});

await step('a cookie without steamLoginSecure is refused', async () => {
  await tab(page, 'keys');
  await page.click('[data-act="check"]');
  await page.waitForSelector('#f-cookie', { timeout: 8000 });
  await fill(page, { 'f-cookie': 'sessionid=abc' });
  await submit(page);
  await sleep(600);
  check(await dlgOpen(page), 'an incomplete cookie was accepted');
  const err = await dlgError(page);
  check(err && /steamLoginSecure/i.test(err), `it said: ${err}`);
  await closeDialog(page);
});

await step('scanning and checking with nothing connected say which is missing', async () => {
  for (const [where, act, expect] of [
    ['sale', 'scan', /isthereanydeal|api key/i],
    ['keys', 'check', /steamworks|cookie|sign in/i],
  ]) {
    await tab(page, where);
    const button = page.locator(`[data-act="${act}"]`).first();
    if (await button.count() === 0) { fault(`no ${act} button on the ${where} tab`); continue; }
    await button.click();
    await sleep(1800);
    const text = (await bodyText(page)) + ' ' + ((await dlgError(page)) ?? '');
    check(expect.test(text), `${act} without credentials produced: ${text.slice(0, 200)}`);
    await closeDialog(page);
  }
});

/* ---------- Act 7: getting the data back out ---------- */

await step('the ledger exports as a CSV the browser downloads', async () => {
  await tab(page, 'keys');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('.exportlink'),
  ]);
  const file = join(work, 'ledger.csv');
  await download.saveAs(file);
  const csv = (await import('node:fs')).readFileSync(file, 'utf8');
  check(csv.startsWith('key,game,batch'), `the CSV starts: ${csv.slice(0, 60)}`);
  check(csv.split('\n').length > 40, 'the export is shorter than the ledger');
  check(csv.includes('Pixel Ledger'), 'the export lost the recipients');
});

/* ---------- Act 8: scale ---------- */

await step('three thousand keys stay usable', async () => {
  const started = Date.now();
  await page.evaluate(async (keys) => {
    const t = new URL(location.href).searchParams.get('t');
    await fetch(`/api/import/keys?t=${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'Lanternfall', batch: 'bulk', text: keys }),
    });
  }, KEYS(3000, 'DDDDD').join('\n'));
  const importMs = Date.now() - started;
  check(importMs < 20000, `importing 3000 keys took ${importMs}ms`);

  const total = await page.evaluate(async () => {
    const t = new URL(location.href).searchParams.get('t');
    return (await (await fetch(`/api/keys?game=Lanternfall&limit=1&t=${t}`)).json()).total;
  });
  check(total >= 3000, `only ${total} keys after importing 3000, so the import did not land`);

  const drawn = Date.now();
  await tab(page, 'keys');
  await page.click('[data-act="filter"][data-filter="all"]');
  await page.waitForSelector('#view tbody tr');
  const drawMs = Date.now() - drawn;
  check(drawMs < 8000, `drawing the keys tab took ${drawMs}ms`);

  const shown = await rowCount(page);
  const text = await bodyText(page);
  check(shown <= 2000, `${shown} rows in the DOM at once`);
  if (shown < 3000) {
    check(/showing|first|of \d/i.test(text), `${shown} of 3000+ rows are shown and nothing says so`);
  }
});

/* ---------- Act 9: the password ---------- */

await context.close();
server.proc.kill();
await sleep(400);

await step('a password gates the browser', async () => {
  execFileSync(process.execPath, ['dist/cli.js', 'password', 'set'], {
    cwd: root,
    env: { ...process.env, HOME: work, USERPROFILE: work },
    input: 'correct horse battery',
    encoding: 'utf8',
  });
  server = await startServer();
  const fresh = await browser.newContext({ viewport: { width: 1320, height: 900 } });
  const login = await fresh.newPage();
  await login.goto(server.url);
  await sleep(500);

  const isLogin = await login.locator('input[type="password"]').count();
  check(isLogin === 1, 'the password page did not appear');

  await login.fill('input[type="password"]', 'wrong');
  await Promise.all([
    login.waitForResponse((r) => r.url().includes('/api/login'), { timeout: 8000 }).catch(() => null),
    login.press('input[type="password"]', 'Enter'),
  ]);
  await sleep(800);
  const stillOut = await login.locator('input[type="password"]').count();
  check(stillOut === 1, 'a wrong password let us in');
  const said = await login.evaluate(() => document.body.innerText);
  check(/wrong|again|incorrect|no/i.test(said), `a wrong password produced: ${said.slice(0, 120)}`);

  await login.fill('input[type="password"]', 'correct horse battery');
  await Promise.all([
    login.waitForResponse((r) => r.url().includes('/api/login'), { timeout: 8000 }).catch(() => null),
    login.press('input[type="password"]', 'Enter'),
  ]);
  await ready(login);
  check((await login.evaluate(() => document.body.innerText)).includes('Lanternfall'),
    'the right password did not reach the app');
  await fresh.close();
});

await step('ten wrong answers earn a lockout', async () => {
  const attempt = async (password) => {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/login?t=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify({ password }),
    });
    return { status: r.status, body: await r.text() };
  };
  let locked = null;
  for (let i = 0; i < 12 && !locked; i += 1) {
    const r = await attempt(`nope-${i}`);
    if (/lock|wait|too many/i.test(r.body)) locked = i + 1;
  }
  check(locked !== null, 'twelve wrong passwords in a row never triggered a lockout');
  if (locked) {
    const right = await attempt('correct horse battery');
    check(right.status >= 400, 'the lockout let the correct password straight through');
  }
});

server.proc.kill();
await sleep(300);
execFileSync(process.execPath, ['dist/cli.js', 'password', 'clear'], {
  cwd: root, env: { ...process.env, HOME: work, USERPROFILE: work }, encoding: 'utf8',
});

/* ---------- Act 10: with the database encrypted ---------- */

await step('the UI works against an encrypted database', async () => {
  const key = 'a'.repeat(64);
  cli('encrypt', '--db', DB, '--key', key);
  check(existsSync(`${DB}.enc`), 'no encrypted file was written');
  check(!existsSync(DB), 'the plain database is still there');

  process.env.KEYWARD_DB_KEY = key;
  server = await startServer();
  const enc = await browser.newContext({ viewport: { width: 1320, height: 900 } });
  const p2 = await enc.newPage();
  p2.on('pageerror', (e) => fault(`uncaught in the page: ${e.message}`));
  await p2.goto(server.url);
  await ready(p2);
  await selectGame(p2, 'Lanternfall');
  check((await p2.evaluate(() => document.body.innerText)).includes('Lanternfall'),
    'the encrypted database did not open');

  await p2.click('[data-act="tab"][data-tab="keys"]');
  await sleep(300);
  await p2.click('[data-act="assign"]');
  await p2.waitForSelector('#f-recipient');
  await p2.fill('#f-recipient', 'After Encryption');
  await p2.click('[data-act="submit"]');
  await p2
    .waitForFunction(() => {
      const dlg = document.getElementById('dlg');
      const err = document.getElementById('dlg-error');
      return dlg?.open !== true || (err && !err.hidden) || dlg.querySelector('[data-act="submit"]') === null;
    }, null, { timeout: 10000 })
    .catch(() => fault('handing out a key on an encrypted database never answered'));
  const encErr = await dlgError(p2);
  check(!encErr, `handing out a key on an encrypted database failed: ${encErr}`);
  await sleep(600);
  await enc.close();
  server.proc.kill();
  await sleep(500);

  const out = cli('export', '--db', DB);
  check(out.includes('After Encryption'), 'a write made through the UI did not survive the restart');
  delete process.env.KEYWARD_DB_KEY;
});

/* ---------- what happened ---------- */

await browser.close();
try { server.proc.kill(); } catch { /* already down */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length} steps, ${results.length - failed.length} clean\n`);
for (const r of results) {
  console.log(`  ${r.ok ? '+' : 'x'} ${r.name}${r.ok ? '' : ''} (${r.ms}ms)`);
}
if (faults.length) {
  console.log(`\n  ${faults.length} thing${faults.length === 1 ? '' : 's'} to look at:\n`);
  for (const f of faults) console.log(`  - [${f.where}] ${f.what}`);
} else {
  console.log('\n  Nothing to report.');
}
rmSync(work, { recursive: true, force: true });
process.exit(faults.length ? 1 : 0);
