// The situations a database gets into, rather than the commands run against it.
//
//   npm run states
//
// A fresh install with no config at all, a config someone edited by hand into
// nonsense, an encrypted file whose key is gone, a database from an older
// version missing columns, two keyward processes at once, ten thousand keys, a
// half-finished encryption, the demo sitting beside the real thing.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const faults = [];
let checks = 0;
let current = '';

function check(condition, what) {
  checks += 1;
  if (!condition) faults.push(`[${current}] ${what}`);
}

/** A fresh HOME for each situation, so none of them can lean on another. */
function situation(name, fn) {
  current = name;
  const work = mkdtempSync(join(tmpdir(), 'keyward-state-'));
  const env = { ...process.env, HOME: work, USERPROFILE: work };
  delete env.KEYWARD_DB_KEY;
  const cli = (args, opts = {}) => {
    const r = spawnSync(process.execPath, ['dist/cli.js', ...args], {
      cwd: root,
      env: { ...env, ...(opts.env ?? {}) },
      encoding: 'utf8',
      input: opts.input ?? '',
      timeout: 60000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (/\bat [A-Za-z_$][\w$.]* \(|node:internal|TypeError|ReferenceError/.test(out)) {
      faults.push(`[${name}] keyward ${args.slice(0, 3).join(' ')} showed a stack trace: ${out.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    return { status: r.status, out };
  };
  try {
    fn({ work, env, cli, config: join(work, '.config', 'keyward') });
  } catch (e) {
    faults.push(`[${name}] the situation itself threw: ${e.message.split('\n')[0]}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* ---------- 1. nothing installed yet ---------- */

situation('a fresh install', ({ cli }) => {
  const list = cli(['game', 'list']);
  check(list.status === 0, `game list on a new machine exited ${list.status}`);
  check(/no games/i.test(list.out), `it said: ${list.out.slice(0, 100)}`);

  const report = cli(['report', '--game', 'Anything']);
  check(report.status !== 0, 'a report on a game that does not exist exited 0');
  check(/no game matching/i.test(report.out), `it said: ${report.out.slice(0, 100)}`);

  check(cli(['rules']).status === 0, 'the rules cannot be listed without a database');
  check(cli(['export']).status === 0, 'exporting an empty ledger failed');
});

/* ---------- 2. a config file someone edited by hand ---------- */

for (const [what, contents] of [
  ['not JSON', 'this is not json'],
  ['an array', '[1,2,3]'],
  ['null', 'null'],
  ['a number', '42'],
  ['empty', ''],
  ['the wrong types', '{"country":5,"rules":"none","dbPath":{"a":1},"itadKey":[]}'],
  ['a dbPath that does not exist', '{"dbPath":"/nowhere/at/all/keyward.db"}'],
  ['a dbPath that is a folder', '{"dbPath":"/tmp"}'],
  ['unknown rules', '{"rules":{"nonsense":-4,"dormantDays":"soon"}}'],
]) {
  situation(`a config that is ${what}`, ({ cli, config }) => {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.json'), contents);
    const r = cli(['game', 'list']);
    check(r.status !== null, 'keyward never came back');
    check(!/JSON|SyntaxError|Unexpected token/.test(r.out),
      `the parser's own words reached the person: ${r.out.replace(/\s+/g, ' ').slice(0, 120)}`);
    const rules = cli(['rules']);
    check(!/NaN|undefined/.test(rules.out), `the thresholds read: ${rules.out.replace(/\s+/g, ' ').slice(0, 120)}`);
  });
}

/* ---------- 3. a database from an older version ---------- */

situation('a database missing the newer columns', ({ work, cli }) => {
  const DB = join(work, 'old.db');
  // Built by hand with the original schema: no image, no store_url.
  execFileSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(DB)});
    db.exec('CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, steam_appid INTEGER UNIQUE, itad_id TEXT)');
    db.prepare('INSERT INTO games (name, steam_appid) VALUES (?, ?)').run('Old Game', 1);
    db.close();
  `], { cwd: root });

  const r = cli(['game', 'list', '--db', DB]);
  check(r.status === 0, `an older database would not open: ${r.out.slice(0, 140)}`);
  check(/Old Game/.test(r.out), 'the game that was already there is gone');

  const added = cli(['game', 'appid', '--game', 'Old Game', '--appid', '99', '--db', DB]);
  check(added.status === 0, `the migrated columns are not usable: ${added.out.slice(0, 120)}`);
});

/* ---------- 4. an encrypted database in every awkward state ---------- */

situation('an encrypted database', ({ work, cli }) => {
  const DB = join(work, 'e.db');
  const KEY = 'b'.repeat(64);
  cli(['game', 'add', '--name', 'G', '--db', DB]);
  cli(['encrypt', '--db', DB, '--key', KEY]);

  const noKey = cli(['game', 'list', '--db', DB]);
  check(noKey.status !== 0, 'an encrypted database opened without the key');
  check(/recovery code|not available/i.test(noKey.out), `it said: ${noKey.out.slice(0, 140)}`);
  check(!/[0-9a-f]{64}/.test(noKey.out), 'the message printed the key it was missing');

  const wrong = cli(['game', 'list', '--db', DB], { env: { KEYWARD_DB_KEY: 'c'.repeat(64) } });
  check(/would not decrypt/i.test(wrong.out), `a wrong key said: ${wrong.out.slice(0, 120)}`);

  const short = cli(['game', 'list', '--db', DB], { env: { KEYWARD_DB_KEY: 'abc' } });
  check(short.status !== 0 && /64 hex|recovery code/i.test(short.out),
    `a malformed key said: ${short.out.slice(0, 120)}`);

  // A truncated file: the tag no longer covers the body.
  const sealed = `${DB}.enc`;
  const whole = readFileSync(sealed);
  writeFileSync(sealed, whole.subarray(0, whole.length - 40));
  const cut = cli(['game', 'list', '--db', DB], { env: { KEYWARD_DB_KEY: KEY } });
  check(cut.status !== 0 && /would not decrypt|altered/i.test(cut.out),
    `a truncated file said: ${cut.out.slice(0, 120)}`);
  writeFileSync(sealed, whole);

  // A plain database left beside the encrypted one.
  writeFileSync(DB, 'left over from before');
  const both = cli(['game', 'list', '--db', DB], { env: { KEYWARD_DB_KEY: KEY } });
  check(both.status === 0, `with both files present it failed: ${both.out.slice(0, 140)}`);
  check(/\bG\b/.test(both.out), 'it read the stale plain file instead of the encrypted one');
});

/* ---------- 5. two keyward processes at once ---------- */

situation('two processes on the same plain database', ({ work, cli }) => {
  const DB = join(work, 'shared.db');
  cli(['game', 'add', '--name', 'G', '--db', DB]);
  writeFileSync(join(work, 'k.txt'), Array.from({ length: 40 }, (_, i) => `AAAAA-${String(i).padStart(5, '0')}-ZZZZZ`).join('\n'));
  cli(['import', 'keys', '--game', 'G', '--batch', 'b', '--file', join(work, 'k.txt'), '--db', DB]);

  const both = [1, 2].map((n) =>
    spawnSync(process.execPath, ['dist/cli.js', 'assign', '--game', 'G', '--recipient', `Person ${n}`, '--db', DB], {
      cwd: root, env: { ...process.env, HOME: work, USERPROFILE: work }, encoding: 'utf8',
    }),
  );
  for (const [i, r] of both.entries()) {
    check(r.status === 0, `process ${i + 1} failed: ${(r.stdout ?? '') + (r.stderr ?? '')}`.slice(0, 140));
  }
  const ledger = cli(['export', '--db', DB]).out;
  check(/Person 1/.test(ledger) && /Person 2/.test(ledger), 'one of the two writes was lost');
});

/* ---------- 6. a big ledger ---------- */

situation('ten thousand keys', ({ work, cli }) => {
  const DB = join(work, 'big.db');
  cli(['game', 'add', '--name', 'G', '--db', DB]);
  const file = join(work, 'many.txt');
  writeFileSync(file, Array.from({ length: 10000 }, (_, i) =>
    `${String(i % 26 + 10).padStart(2, 'A')}AAA-${String(i).padStart(5, '0')}-ZZZZZ`).join('\n'));

  let started = Date.now();
  const imported = cli(['import', 'keys', '--game', 'G', '--batch', 'bulk', '--file', file, '--db', DB]);
  const importMs = Date.now() - started;
  check(imported.status === 0, `importing 10,000 keys failed: ${imported.out.slice(0, 140)}`);
  check(importMs < 30000, `importing 10,000 keys took ${(importMs / 1000).toFixed(1)}s`);

  started = Date.now();
  const report = cli(['report', '--game', 'G', '--db', DB]);
  const reportMs = Date.now() - started;
  check(report.status === 0, 'the report failed on a big ledger');
  check(reportMs < 15000, `the report took ${(reportMs / 1000).toFixed(1)}s over 10,000 keys`);

  started = Date.now();
  const exported = cli(['export', '--db', DB]);
  check(exported.out.split('\n').length > 10000, 'the export is missing rows');
  check(Date.now() - started < 20000, 'the export took too long');
});

/* ---------- 7. the demo beside the real thing ---------- */

situation('the demo and the real database side by side', ({ cli, config }) => {
  cli(['game', 'add', '--name', 'Real Game']);
  const before = readFileSync(join(config, 'keyward.db'));

  check(cli(['demo', '--force', '--no-icons']).status === 0, 'seeding the demo failed');
  check(cli(['demo', '--force', '--no-icons']).status === 0, 're-seeding the demo failed');

  const after = readFileSync(join(config, 'keyward.db'));
  check(before.equals(after), 'seeding the demo changed the real database');
  check(/Real Game/.test(cli(['game', 'list']).out), 'the real game is gone');
  check(existsSync(join(config, 'demo.db')), 'the demo database was not written');
});

/* ---------- 8. watch, which is what cron runs ---------- */

situation('watch on a quiet ledger', ({ work, cli }) => {
  const DB = join(work, 'w.db');
  cli(['game', 'add', '--name', 'G', '--db', DB]);
  writeFileSync(join(work, 'k.txt'), Array.from({ length: 8 }, (_, i) => `AAAAA-${String(i).padStart(5, '0')}-ZZZZZ`).join('\n'));
  cli(['import', 'keys', '--game', 'G', '--batch', 'b', '--file', join(work, 'k.txt'), '--db', DB]);

  const quiet = cli(['watch', '--game', 'G', '--quiet', '--db', DB]);
  check(quiet.status === 0, `watch found something to report on a quiet ledger: ${quiet.out.slice(0, 140)}`);

  // The rules ask for a pattern, not a single key, so one hand-out is not
  // something to report. Give the same person several and backdate them.
  for (let i = 0; i < 4; i += 1) cli(['assign', '--game', 'G', '--recipient', 'Someone', '--db', DB]);
  execFileSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(DB)});
    db.exec("UPDATE assignments SET assigned_at = datetime('now','-90 days')");
    db.close();
  `], { cwd: root });

  const noisy = cli(['watch', '--game', 'G', '--db', DB]);
  check(noisy.status === 1, `watch exited ${noisy.status} with something new to say`);
  const again = cli(['watch', '--game', 'G', '--db', DB]);
  check(again.status === 0, 'watch reported the same finding twice, so cron would email every hour');
});

/* ---------- 9. a spreadsheet is not a shell ---------- */

situation('an export opened in a spreadsheet', ({ work, cli }) => {
  const DB = join(work, 'csv.db');
  cli(['game', 'add', '--name', 'G', '--db', DB]);
  writeFileSync(join(work, 'k.txt'), 'AAAAA-BBBBB-CCCCC');
  cli(['import', 'keys', '--game', 'G', '--batch', 'b', '--file', join(work, 'k.txt'), '--db', DB]);
  cli(['assign', '--game', 'G', '--recipient', '=HYPERLINK("http://evil.example","click")', '--db', DB]);

  const csv = cli(['export', '--db', DB]).out;
  const cells = csv.split('\n').slice(1).flatMap((line) => line.split('","'));
  const dangerous = cells.filter((c) => /^"?[=+\-@\t\r]/.test(c.replace(/^"/, '')));
  check(dangerous.length === 0,
    `a cell starts with a character a spreadsheet runs: ${dangerous[0]?.slice(0, 60)}`);
});

/* ---------- 10. an encryption that was interrupted ---------- */

situation('a half-written encryption', ({ work, cli }) => {
  const DB = join(work, 'i.db');
  const KEY = 'd'.repeat(64);
  cli(['game', 'add', '--name', 'G', '--db', DB]);
  cli(['encrypt', '--db', DB, '--key', KEY]);

  // What a crash between the write and the rename leaves behind.
  writeFileSync(`${DB}.enc.tmp`, 'half a file');
  const r = cli(['game', 'list', '--db', DB], { env: { KEYWARD_DB_KEY: KEY } });
  check(r.status === 0, `a leftover temporary file broke the open: ${r.out.slice(0, 140)}`);

  const size = statSync(`${DB}.enc`).size;
  cli(['assign', '--game', 'G', '--recipient', 'X', '--db', DB], { env: { KEYWARD_DB_KEY: KEY } });
  check(statSync(`${DB}.enc`).size >= size, 'the sealed file shrank after a write');
});

/* ---------- what happened ---------- */

console.log(`\n  ${checks} checks across the situations\n`);
if (faults.length) {
  console.log(`  ${faults.length} to look at:\n`);
  for (const f of faults) console.log(`  - ${f}`);
} else {
  console.log('  Nothing to report.');
}
process.exit(faults.length ? 1 : 0);
