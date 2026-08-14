// Every command, said wrongly.
//
//   npm run cli-matrix
//
// The unit tests call the command functions. This runs the binary the way a
// person does, with flags missing, flags misspelt, values that are not what the
// flag wants, and paths that do not exist or cannot be written.
//
// What is being asserted is the answer, not the failure. Failing is often
// correct. What is never correct is a stack trace, SQLite's own words, a path
// from inside this machine, an exit code of 0 on something that did not work,
// or a message that does not tell the person what to do instead.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'keyward-cli-'));
const env = { ...process.env, HOME: work, USERPROFILE: work, KEYWARD_NO_COLOR: '1' };

const faults = [];
let runs = 0;

const LEAKS = [
  [/\bat [A-Za-z_$][\w$.]* \(/, 'a stack frame'],
  [/\.(ts|js):\d+:\d+/, 'a source position'],
  [/SQLITE_|constraint failed|no such (table|column)|syntax error near/i, 'SQLite raw'],
  [/node:internal|node_modules/, 'the runtime internals'],
  [/TypeError|ReferenceError|Cannot read propert/, 'a programming error'],
];

/** Runs the binary and returns what a person would see. */
function run(args, opts = {}) {
  runs += 1;
  const r = spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: root,
    env: { ...env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    input: opts.input ?? '',
    timeout: 30000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const label = `keyward ${args.join(' ')}`.slice(0, 110);

  for (const [pattern, what] of LEAKS) {
    if (pattern.test(out)) {
      faults.push(`${label} leaked ${what}: ${out.replace(/\s+/g, ' ').slice(0, 160)}`);
      break;
    }
  }
  if (r.status === null) faults.push(`${label} never finished`);
  return { status: r.status, out, label };
}

/** A command that cannot work has to say so and exit non-zero. */
function refuses(args, expect, opts = {}) {
  const r = run(args, opts);
  if (r.status === 0) faults.push(`${r.label} exited 0, and it should not have`);
  if (expect && !expect.test(r.out)) {
    faults.push(`${r.label} said: ${r.out.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  }
  return r;
}

function works(args, expect, opts = {}) {
  const r = run(args, opts);
  if (r.status !== 0) {
    faults.push(`${r.label} exited ${r.status}: ${r.out.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  }
  if (expect && !expect.test(r.out)) {
    faults.push(`${r.label} did not say what was expected: ${r.out.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  return r;
}

/* ---------- a database to work on ---------- */

const DB = join(work, 'cli.db');
const db = ['--db', DB];
const KEYS = join(work, 'keys.txt');
writeFileSync(KEYS, Array.from({ length: 30 }, (_, i) => `AAAAA-${String(i).padStart(5, '0')}-ZZZZZ`).join('\n'));

/* ---------- 1. saying nothing, and saying nonsense ---------- */

works([], /keyward/, {});                       // bare invocation prints usage
works(['--help'], /keyward/);
refuses(['nonsense-command'], /unknown command/i);
refuses(['game'], /usage|game (add|list)/i);
refuses(['import'], /usage|import/i);
refuses(['batch'], /usage|batch/i);
refuses(['contact'], /usage|contact/i);
refuses(['key'], /usage|key/i);

/* ---------- 2. every command without what it needs ---------- */

for (const [args, expect] of [
  [['game', 'add'], /name/i],
  [['game', 'rename'], /game|to/i],
  [['game', 'appid'], /game|appid/i],
  [['game', 'delete'], /game/i],
  [['import', 'keys'], /game|batch|file/i],
  [['import', 'recipients'], /file/i],
  [['assign'], /game|recipient/i],
  [['check'], /game/i],
  [['scan'], /game/i],
  [['report'], /game/i],
  [['trace'], /key|usage/i],
  [['batch', 'list'], /game/i],
  [['batch', 'new'], /game|batch/i],
  [['batch', 'rename'], /game|batch|to/i],
  [['batch', 'delete'], /game|batch/i],
  [['contact', 'rename'], /recipient|to/i],
  [['contact', 'edit'], /recipient/i],
  [['contact', 'delete'], /recipient/i],
  [['key', 'delete'], /key|usage/i],
  [['key', 'revoke'], /key|usage/i],
  [['restore-key'], /unknown command|code/i],
]) {
  refuses([...args, ...db], expect);
}

// config set is the one command where --db is not "use this one now" but "use
// this one from now on", so it cannot carry the flag the others do.
refuses(['config', 'set'], /nothing to set/i);

/* ---------- 3. flags that are not flags, values that are not values ---------- */

refuses(['game', 'add', '--nmae', 'Typo', ...db], /unknown|nmae|usage/i);
refuses(['game', 'add', '--name', ...db], /db|expects|argument/i); // --name eats --db
works(['game', 'add', '--name', 'Lanternfall', '--appid', '2417830', ...db], /Added/i);
refuses(['game', 'add', '--name', 'Lanternfall', ...db], /already/i);
refuses(['game', 'add', '--name', '   ', ...db], /empty|name/i);
refuses(['game', 'add', '--name', 'x'.repeat(500), ...db], /under 200/i);

for (const appid of ['abc', '-5', '3.9', '99999999999999999999', '0', ' ']) {
  const r = run(['game', 'add', '--name', `Appid ${appid}`, '--appid', appid, ...db]);
  if (r.status === 0) {
    const shown = run(['game', 'list', ...db]).out;
    if (/NaN|undefined|Infinity/.test(shown)) faults.push(`an appid of "${appid}" left ${shown.match(/\S*(NaN|undefined|Infinity)\S*/)?.[0]} in the list`);
  }
}

/* ---------- 4. importing from places that are not files ---------- */

works(['import', 'keys', '--game', 'Lanternfall', '--batch', 'press', '--file', KEYS, ...db], /30/);
works(['import', 'keys', '--game', 'Lanternfall', '--batch', 'press', '--file', KEYS, ...db], /0 new|already/i);

refuses(['import', 'keys', '--game', 'Lanternfall', '--batch', 'b', '--file', join(work, 'nope.txt'), ...db], /no such file|cannot (read|find)|does not exist/i);
refuses(['import', 'keys', '--game', 'Lanternfall', '--batch', 'b', '--file', work, ...db], /director|read/i);
refuses(['import', 'keys', '--game', 'Nope', '--batch', 'b', '--file', KEYS, ...db], /no game matching/i);

const empty = join(work, 'empty.txt');
writeFileSync(empty, '');
refuses(['import', 'keys', '--game', 'Lanternfall', '--batch', 'b', '--file', empty, ...db], /no keys/i);

const binary = join(work, 'binary.bin');
writeFileSync(binary, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
refuses(['import', 'keys', '--game', 'Lanternfall', '--batch', 'b', '--file', binary, ...db], /no keys|not a zip|zip/i);

/* ---------- 5. --db pointing somewhere impossible ---------- */

refuses(['game', 'list', '--db', work], /is a folder/i);
works(['game', 'list', '--db', join(work, 'a', 'b', 'c', 'deep.db')], /no games/i); // makes the folder
const notADb = join(work, 'notadb.db');
writeFileSync(notADb, 'this is definitely not a SQLite file, it is prose');
refuses(['game', 'list', '--db', notADb], /is not a keyward database/i);

const readonly = join(work, 'readonly');
mkdirSync(readonly);
chmodSync(readonly, 0o500);
refuses(['game', 'add', '--name', 'X', '--db', join(readonly, 'x.db')], /cannot open|writable/i);
chmodSync(readonly, 0o700);

/* ---------- 6. the rest of the surface, on real data ---------- */

works(['game', 'list', ...db], /Lanternfall/);
works(['assign', '--game', 'Lanternfall', '--recipient', 'Pixel Ledger', ...db], /AAAAA/);
works(['assign', '--game', 'Lanternfall', '--recipient', 'Pixel Ledger', '--campaign', 'launch', ...db], /AAAAA/);
refuses(['assign', '--game', 'Lanternfall', '--recipient', 'X', '--batch', 'nope', ...db], /no unused|no keys|batch/i);
works(['report', '--game', 'Lanternfall', ...db], /Lanternfall/);
works(['report', '--game', 'Lanternfall', '--json', ...db], /"game"/);
works(['report', '--game', '2417830', ...db], /Lanternfall/);   // by appid
works(['batch', 'list', '--game', 'Lanternfall', ...db], /press/);
works(['batch', 'new', '--game', 'Lanternfall', '--batch', 'creators', ...db], /creators/);
refuses(['batch', 'new', '--game', 'Lanternfall', '--batch', 'creators', ...db], /already/i);
works(['batch', 'rename', '--game', 'Lanternfall', '--batch', 'creators', '--to', 'streamers', ...db], /streamers/i);
works(['batch', 'delete', '--game', 'Lanternfall', '--batch', 'streamers', ...db], /.*/);
refuses(['batch', 'delete', '--game', 'Lanternfall', '--batch', 'press', ...db], /hold|not empty|keys/i);
works(['contact', 'edit', '--recipient', 'Pixel Ledger', '--email', 'hi@example.com', ...db], /.*/);
works(['contact', 'rename', '--recipient', 'Pixel Ledger', '--to', 'Pixel Ledger Ltd', ...db], /.*/);
refuses(['contact', 'delete', '--recipient', 'Pixel Ledger Ltd', ...db], /holds/i);
refuses(['contact', 'delete', '--recipient', 'Nobody Here', ...db], /no.*contact|no such/i);
works(['trace', 'AAAAA-00000-ZZZZZ', ...db], /Pixel Ledger Ltd/);
works(['trace', 'AAAAA-00000-ZZZZZ', '--json', ...db], /"key"/);
refuses(['trace', 'not-a-key', ...db], /shaped|key/i);
// A key that is not yours is an answer, not a failure, so it exits 0.
works(['trace', 'QQQQQ-QQQQQ-QQQQQ', ...db], /not one of|no record|not yours|never/i);
refuses(['key', 'delete', 'AAAAA-00000-ZZZZZ', ...db], /handed out/i);
works(['key', 'delete', 'AAAAA-00029-ZZZZZ', ...db], /.*/);
works(['key', 'revoke', 'AAAAA-00000-ZZZZZ', '--note', 'found on Kinguin', ...db], /steamgames/);
works(['export', '--game', 'Lanternfall', ...db], /^key,game,batch/m);
works(['export', ...db], /^key,game,batch/m);
works(['export', '--json', ...db], /\[/);
works(['rules', ...db], /confirmed-on-sale/);
works(['config', 'set', '--country', 'ES', '--no-verify'], /Saved/);
refuses(['config', 'set', '--itad-key', 'nonsense', ...db], /key|refused|look/i);
works(['password'], /no password|usage/i);
works(['watch', '--game', 'Lanternfall', '--quiet', ...db], /.*/);

/* ---------- 7. things that need a network that is not there ---------- */

for (const args of [
  ['check', '--game', 'Lanternfall', ...db],
  ['scan', '--game', 'Lanternfall', ...db],
]) {
  const r = run(args, { env: { KEYWARD_STEAM_COOKIE: '', KEYWARD_ITAD_KEY: '' } });
  if (!/steamworks|cookie|isthereanydeal|api key|connect/i.test(r.out)) {
    faults.push(`${r.label} without credentials said: ${r.out.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

/* ---------- 8. the demo, which must never touch the real ledger ---------- */

works(['demo', '--force', '--no-icons'], /Seeded/);
const real = run(['game', 'list']);            // no --db: the default path
if (/Lanternfall|Seeded/.test(real.out) && !/no games/i.test(real.out)) {
  // The default database should still be empty: everything above used --db.
  if (/\bkeys=\d+/.test(real.out)) faults.push(`the default database has data in it: ${real.out.slice(0, 120)}`);
}

/* ---------- what happened ---------- */

rmSync(work, { recursive: true, force: true });
console.log(`\n  ${runs} invocations\n`);
if (faults.length) {
  console.log(`  ${faults.length} to look at:\n`);
  for (const f of faults) console.log(`  - ${f}`);
} else {
  console.log('  Nothing to report.');
}
process.exit(faults.length ? 1 : 0);
