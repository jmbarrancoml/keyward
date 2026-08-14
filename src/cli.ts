#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { openDb, saveDb, convertDb, sealedPath, isSealed } from './db.js';
import { country, dbPath, demoDbPath, saveConfig, configPath, loadConfig, thresholds, type Config } from './config.js';
import { RULES, DEFAULT_THRESHOLDS } from './rules.js';
import { seedDemo } from './commands/demo.js';
import { trace } from './commands/trace.js';
import { listBatches, createBatch, renameBatch, deleteBatch } from './commands/batches.js';
import { watch } from './commands/watch.js';
import { exportLedger } from './commands/export.js';
import { handOut, toHandoutCsv } from './commands/handout.js';
import { unusedKeys, remindList } from './commands/hygiene.js';
import { newKey, storeKey, loadKey, forgetKey, recoveryCode, parseRecoveryCode, keyHome } from './crypto.js';
import { keystoreName } from './keystore.js';
import {
  renameGame, setGameAppid, deleteGame, renameContact, editContact,
  deleteContact, deleteKey, revokeKey,
} from './commands/edit.js';
import { setPassword, clearPassword, hasPassword } from './password.js';
import { setSteamCookie, clearSteamCookie } from './secrets.js';
import { gameAdd, gameList, importKeys, importRecipients, assign } from './commands/manage.js';
import { check } from './commands/check.js';
import { scan } from './commands/scan.js';
import { report } from './commands/report.js';

const USAGE = `keyward — local-first key hygiene for game studios

  keyward game add --name <name> [--appid <id>]
  keyward game list
  keyward import keys --game <name|appid> --batch <name> --file <csv|txt>
  keyward import recipients --file <csv>          columns: name[,email][,kind][,handle]
  keyward assign --game <name|appid> --recipient <name> [--campaign <name>] [--batch <name>]
  keyward check --game <name|appid> [--limit <n>] [--delay <ms>] [--all] [--since <hours>]
  keyward scan --game <name|appid> [--country <cc>]
  keyward report --game <name|appid> [--dormant-days <n>] [--json]
  keyward trace <key> [--seen-on <shop>] [--country <cc>] [--json]  who did this key go to?
  keyward batch list --game <name|appid>
  keyward batch new --game <name|appid> --batch <name> [--note <text>] [--region <cc>]
  keyward batch rename --game <name|appid> --batch <from> --to <name>   merges if <name> exists
  keyward batch delete --game <name|appid> --batch <name>               empty batches only
  keyward game rename --game <name> --to <name>
  keyward game appid  --game <name> --appid <id>
  keyward game delete --game <name> [--force]     removes the game and everything under it
  keyward contact rename --recipient <name> --to <name>   merges if <name> exists
  keyward contact edit   --recipient <name> [--email <e>] [--kind <k>] [--handle <h>]
  keyward contact delete --recipient <name>       only if they hold no keys
  keyward key delete <key>                        only if it was never handed out
  keyward key revoke <key> [--note <why>]         records that you revoked it in Steamworks
  keyward handout --game <name> --batch <name> --file <csv> [--campaign <name>]
                                                  one key per person, CSV out for a mail merge
  keyward remind --game <name> [--dormant-days <n>]  who to chase, with their email
  keyward unused [--game <name>]                  keys generated and never handed out
  keyward export [--game <name>] [--json]         the whole ledger, to stdout
  keyward rules                                   the suspect rules and their thresholds
  keyward watch [--game <name>] [--limit <n>] [--notify] [--webhook <url>] [--quiet]
                                                  for cron: exits 1 when something is new
  keyward password set | password clear           locks the web UI behind a password
  keyward encrypt [--db <path>] [--key <hex>]     encrypts the database at rest
  keyward decrypt [--db <path>]                   turns it back into a plain file
  keyward ui [--port <n>] [--open] [--demo]       local web UI, 127.0.0.1 only
  keyward demo [--force] [--no-icons]             seed a separate database with invented data
  keyward auth set | auth clear
  keyward config set --itad-key <key> [--country <cc>] [--db <path>] [--no-verify]

Data lives in a local SQLite file (${dbPath()}); nothing is uploaded anywhere.
The Steamworks session cookie is kept in ${keystoreName()}, never in that file.
`;

const options = {
  name: { type: 'string' },
  appid: { type: 'string' },
  game: { type: 'string' },
  batch: { type: 'string' },
  file: { type: 'string' },
  recipient: { type: 'string' },
  campaign: { type: 'string' },
  note: { type: 'string' },
  limit: { type: 'string' },
  delay: { type: 'string' },
  country: { type: 'string' },
  'dormant-days': { type: 'string' },
  'itad-key': { type: 'string' },
  db: { type: 'string' },
  port: { type: 'string' },
  open: { type: 'boolean' },
  dev: { type: 'boolean' },
  demo: { type: 'boolean' },
  force: { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  'no-icons': { type: 'boolean' },
  notify: { type: 'boolean' },
  webhook: { type: 'string' },
  quiet: { type: 'boolean' },
  to: { type: 'string' },
  key: { type: 'string' },
  email: { type: 'string' },
  kind: { type: 'string' },
  handle: { type: 'string' },
  'seen-on': { type: 'string' },
  region: { type: 'string' },
  since: { type: 'string' },
  rule: { type: 'string', multiple: true },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function required(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`Missing required --${flag}`);
  return v;
}

/**
 * Seeds the demo database. It lives at its own path and is never the file the
 * other commands open by default, so this cannot overwrite a studio's real key
 * ledger no matter what flags are passed.
 */
async function seedDemoDatabase(force: boolean, quietIfPresent = false, icons = true): Promise<void> {
  const file = demoDbPath();
  const db = openDb(file);
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
    if (n > 0) {
      if (quietIfPresent && !force) return;
      if (!force) {
        throw new Error(`${file} already has data. Re-seed it with: keyward demo --force`);
      }
    }

    // Children before parents, or foreign keys reject the wipe — and all of it
    // in a transaction, so a wipe that fails halfway rolls back instead of
    // leaving a database with keys but no assignments.
    const counts = ((): ReturnType<typeof seedDemo> => {
      db.exec('BEGIN');
      try {
        // shop_icons is deliberately not in this list. Logos are keyed by shop
        // name, cost a network round trip each, and belong to no game, so
        // wiping them on a re-seed threw away work for nothing — and with
        // --no-icons they never came back.
        for (const t of [
          'sightings', 'activations', 'assignments', 'listings',
          'keys', 'batches', 'recipients', 'games', 'meta',
        ]) {
          db.exec(`DELETE FROM ${t}`);
        }
        const seeded = seedDemo(db);
        db.exec('COMMIT');
        return seeded;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    })();
    // The only network call the demo makes, and only so the shop logos are
    // real rather than monograms. --no-icons skips it.
    if (icons) {
      const { refreshShopIcons } = await import('./itad/icons.js');
      const shops = db
        .prepare('SELECT DISTINCT shop_name AS shopName, url FROM listings WHERE url IS NOT NULL')
        .all() as Array<{ shopName: string; url: string }>;
      try {
        const got = await refreshShopIcons(db, shops);
        if (!quietIfPresent) console.log(`Fetched ${got} shop logos.`);
      } catch {
        /* monograms are the fallback */
      }
    }

    if (!quietIfPresent) {
      console.log(`Seeded ${counts.games} games, ${counts.keys} keys and ${counts.recipients} recipients.`);
      console.log(`\n  ${file}\n`);
      console.log('  Everything in it is invented. Open it with:');
      console.log('    keyward ui --demo');
      console.log(`    keyward report --game Lanternfall --db ${file}\n`);
    }
  } finally {
    db.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options, allowPositionals: true, strict: true });
  const [cmd, sub] = positionals;

  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }

  // Config and auth never open the database.
  if (cmd === 'config' && sub === 'set') {
    const patch: Config = {};
    if (values['itad-key']) {
      // Checked against IsThereAnyDeal before it is written, so a key pasted
      // wrong fails here with a reason rather than later as a broken scan.
      if (!values['no-verify']) {
        const { verifyKey } = await import('./itad/client.js');
        process.stderr.write('Checking the key with IsThereAnyDeal… ');
        try {
          await verifyKey(values['itad-key']);
          process.stderr.write('ok\n');
        } catch (e) {
          process.stderr.write('failed\n');
          throw new Error(`${(e as Error).message}\n\n  Use --no-verify to save it anyway.`);
        }
      }
      patch.itadKey = values['itad-key'];
    }
    if (values.country) patch.country = values.country;
    if (values.db) patch.dbPath = values.db;
    if (values.rule) {
      const rules: Record<string, number> = { ...(loadConfig().rules ?? {}) };
      for (const pair of values.rule) {
        const [name, raw] = pair.split('=');
        if (!name || raw === undefined) throw new Error(`Use --rule name=value, got "${pair}".`);
        if (!(name in DEFAULT_THRESHOLDS)) {
          throw new Error(`Unknown rule "${name}". Run: keyward rules`);
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new Error(`"${raw}" is not a number.`);
        rules[name] = value;
      }
      patch.rules = rules;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'Nothing to set. Try --itad-key, --country, --db or --rule name=value.',
      );
    }
    saveConfig(patch);
    console.log(`Saved to ${configPath()}.`);
    if (patch.dbPath) {
      // --db means "use this one now" everywhere else and "use this one from
      // now on" here, which is a surprise worth spelling out.
      console.log(`\nEvery command now opens ${patch.dbPath} unless it is given its own --db.`);
    }
    return;
  }
  if (cmd === 'auth') {
    if (sub === 'clear') {
      clearSteamCookie();
      console.log('Cleared the stored Steamworks session cookie.');
      return;
    }
    if (sub === 'set') {
      console.error('Paste the Cookie: header value, then Ctrl-D:');
      const cookie = await readStdin();
      if (!cookie.includes('steamLoginSecure')) {
        throw new Error('That does not look like a Steamworks cookie. It has to contain steamLoginSecure.');
      }
      setSteamCookie(cookie);
      console.log(`Stored in ${keystoreName()}.`);
      return;
    }
    throw new Error('Usage: keyward auth set | keyward auth clear');
  }

  if (cmd === 'password') {
    if (sub === 'clear') {
      clearPassword();
      console.log('Password removed. The web UI opens with the token alone again.');
      return;
    }
    if (sub === 'set') {
      console.error('New password (at least 8 characters), then Ctrl-D:');
      setPassword(await readStdin());
      console.log('Set. The web UI will ask for it from the next run.');
      console.log('\nIt covers the browser only. The CLI reads the database without');
      console.log('asking. To cover the file itself, run keyward encrypt.');
      return;
    }
    console.log(hasPassword() ? 'A password is set.' : 'No password set.');
    console.log('Usage: keyward password set | keyward password clear');
    return;
  }

  if (cmd === 'encrypt' || cmd === 'decrypt') {
    const file = dbPath(values.db);
    if (cmd === 'encrypt') {
      const key = values.key ? parseRecoveryCode(values.key) : newKey();

      // The key is stored first, on purpose. Encrypting and then failing to
      // keep the key leaves a database nobody can open, including you.
      if (!values.key) {
        try {
          storeKey(key);
        } catch (e) {
          throw new Error(
            `${(e as Error).message}\n\n` +
              'Nothing has been encrypted. Choose a key yourself, keep it somewhere safe,\n' +
              'and pass it in:\n\n' +
              `  keyward encrypt --key ${key.toString('hex')}`,
          );
        }
      }

      convertDb(file, 'sealed', key);
      console.log(`Encrypted. ${sealedPath(file)}`);
      console.log('\n  Write this down and keep it somewhere else:\n');
      console.log(`    ${recoveryCode(key)}\n`);
      console.log(`  The key is in ${keyHome()}, so nothing will ask you for it here.`);
      console.log('  On another machine, or if that store is ever lost, this code is');
      console.log('  the only way back in. Without it the ledger is gone.\n');
      console.log('  It protects the file at rest: a copied database, a backup, a synced');
      console.log('  folder. It cannot protect you from anything running as you.\n');
      return;
    }
    convertDb(file, 'plain', loadKey());
    forgetKey();
    console.log(`Decrypted back to ${file}. The key is out of ${keyHome()} too.`);
    return;
  }

  if (cmd === 'restore-key' && sub) {
    storeKey(parseRecoveryCode(sub));
    console.log(`Recovery code stored in ${keyHome()}. The database will open normally now.`);
    return;
  }

  if (cmd === 'rules') {
    const t = thresholds();
    console.log('\nSuspect rules, most conclusive first:\n');
    for (const r of RULES) {
      console.log(`  ${r.severity.padEnd(8)} ${r.id}`);
      console.log(`           ${r.title}`);
      console.log(`           ${r.description.replace(/(.{68}) /g, '$1\n           ')}\n`);
    }
    console.log('Thresholds (keyward config set --rule name=value):\n');
    for (const [name, value] of Object.entries(t)) {
      console.log(`  ${name.padEnd(18)} ${value}`);
    }
    console.log(
      '\nTune them. What counts as an odd number of dormant keys depends on how you\n' +
        'hand keys out, and a rule that fires on everybody is worth nothing.\n',
    );
    return;
  }

  if (cmd === 'demo') {
    await seedDemoDatabase(Boolean(values.force), false, !values['no-icons']);
    return;
  }

  // The UI owns its own database handle for the lifetime of the server, so it
  // must not run inside the open/close block below.
  if (cmd === 'ui') {
    const { serve } = await import('./ui/server.js');
    if (values.demo) await seedDemoDatabase(false, true, false);
    const { url } = await serve({
      dbFile: values.demo ? demoDbPath() : dbPath(values.db),
      port: Number(values.port ?? 0),
      open: Boolean(values.open),
      ...(values.dev ? { dev: true } : {}),
    });
    console.log(`\n  keyward is running at\n  ${url}\n`);
    if (values.demo) {
      console.log('  Showing invented demo data. Your real database is untouched.\n');
    }
    if (values.dev) {
      console.log('  Dev mode: app.html is served from source and the page reloads on save.\n');
    } else {
      console.log('  Bound to 127.0.0.1 only. The token in that URL is regenerated every run,');
      console.log('  so the link stops working when you stop the server. Ctrl-C to quit.\n');
    }
    if (values.open) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      const { spawn } = await import('node:child_process');
      spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    }
    return;
  }

  const db = openDb(dbPath(values.db));
  try {
    // `trace` takes the key as its second positional, so it must not be folded
    // into the "<command> <subcommand>" route key.
    const bare = ['trace', 'watch', 'export', 'handout', 'remind', 'unused'];
    const route = bare.includes(cmd ?? '') ? (cmd as string) : `${cmd} ${sub ?? ''}`.trim();
    switch (route) {
      case 'trace':
        trace(db, sub ?? '', Boolean(values.json), values['seen-on'], values.country);
        break;
      case 'export':
        exportLedger(db, { ...(values.game ? { game: values.game } : {}), json: Boolean(values.json) });
        break;
      case 'handout': {
        const file = required(values.file, 'file');
        const out = handOut(db, {
          game: required(values.game, 'game'),
          text: readFileSync(file, 'utf8'),
          ...(values.batch ? { batch: values.batch } : {}),
          ...(values.campaign ? { campaign: values.campaign } : {}),
        });
        // The CSV goes to stdout so it pipes straight into a file or a mail
        // merge. Everything else goes to stderr, or it would land in the CSV.
        console.error(
          `Handed out ${out.rows.length} keys from "${out.batch}"` +
            `${out.newContacts ? `, ${out.newContacts} of them to new contacts` : ''}.`,
        );
        process.stdout.write(toHandoutCsv(out.rows));
        break;
      }
      case 'remind': {
        const people = remindList(
          db,
          required(values.game, 'game'),
          Number(values['dormant-days'] ?? 14),
        );
        if (people.length === 0) {
          console.log('Nobody is sitting on a key that was checked and came back unredeemed.');
          break;
        }
        console.log(`\n  ${people.length} worth a follow-up:\n`);
        for (const r of people) {
          console.log(
            `  ${r.name.padEnd(28)} ${String(r.waiting).padStart(3)} waiting` +
              `  ${String(r.oldestDays).padStart(4)}d  ${r.email ?? r.handle ?? 'no contact on file'}`,
          );
        }
        console.log('\n  Checked keys only. Chasing someone over a key you never looked up is');
        console.log('  how you accuse a journalist who redeemed it on day one.\n');
        break;
      }
      case 'unused': {
        const rows = unusedKeys(db, values.game);
        if (rows.length === 0) {
          console.log('Every key you have generated has been handed out.');
          break;
        }
        const total = rows.reduce((n, b) => n + b.unused, 0);
        console.log(`\n  ${total} keys generated and never given to anyone:\n`);
        for (const b of rows) {
          console.log(
            `  ${b.batch.padEnd(24)} ${String(b.unused).padStart(5)} of ${String(b.total).padEnd(6)}` +
              `  ${b.ageDays}d old`,
          );
        }
        console.log('\n  These are the ones that come back redeemed without ever being sent.\n');
        break;
      }
      case 'game rename':
        renameGame(db, required(values.game, 'game'), required(values.to, 'to'));
        console.log(`Renamed to "${values.to}".`);
        break;
      case 'game appid':
        setGameAppid(db, required(values.game, 'game'), values.appid ? Number(values.appid) : null);
        console.log(values.appid ? `Set to ${values.appid}.` : 'Cleared.');
        break;
      case 'game delete': {
        const gone = deleteGame(db, required(values.game, 'game'), Boolean(values.force));
        console.log(`Deleted "${values.game}" and its ${gone.keys} keys.`);
        break;
      }
      case 'contact rename': {
        const r = renameContact(db, required(values.recipient, 'recipient'), required(values.to, 'to'));
        console.log(
          r.merged ? `Merged into "${values.to}", moving ${r.moved} keys across.` : `Renamed to "${values.to}".`,
        );
        break;
      }
      case 'contact edit':
        editContact(db, required(values.recipient, 'recipient'), {
          ...(values.email !== undefined ? { email: values.email } : {}),
          ...(values.kind !== undefined ? { kind: values.kind } : {}),
          ...(values.handle !== undefined ? { handle: values.handle } : {}),
          ...(values.note !== undefined ? { note: values.note } : {}),
        });
        console.log('Updated.');
        break;
      case 'contact delete':
        deleteContact(db, required(values.recipient, 'recipient'));
        console.log(`Deleted "${values.recipient}".`);
        break;
      case 'key delete':
        deleteKey(db, sub === 'delete' ? required(positionals[2], 'key') : '');
        console.log('Deleted.');
        break;
      case 'key revoke': {
        const r = revokeKey(db, required(positionals[2], 'key'), values.note);
        console.log(`Recorded as revoked.\n\n  Do it in Steamworks here:\n  ${r.url}\n`);
        break;
      }
      case 'watch': {
        const results = await watch(db, {
          ...(values.game ? { game: values.game } : {}),
          limit: Number(values.limit ?? 60),
          notify: Boolean(values.notify),
          ...(values.webhook ? { webhook: values.webhook } : {}),
          quiet: Boolean(values.quiet),
        });
        // Non-zero when something is new, so cron mails you the output and
        // stays silent the rest of the time.
        if (results.some((r) => r.fresh.length > 0)) process.exitCode = 1;
        break;
      }
      case 'game add':
        gameAdd(db, {
          name: required(values.name, 'name'),
          ...(values.appid ? { appid: Number(values.appid) } : {}),
        });
        break;
      case 'game list':
        gameList(db);
        break;
      case 'batch list': {
        const rows = listBatches(db, required(values.game, 'game'));
        if (rows.length === 0) console.log('No batches yet.');
        for (const b of rows) {
          console.log(
            `  ${b.batch.padEnd(24)} ${String(b.remaining).padStart(4)} left of ${String(b.keys).padEnd(5)}` +
              `${b.region ? `  [${b.region}]` : ''}${b.note ? `  ${b.note}` : ''}`,
          );
        }
        break;
      }
      case 'batch new':
        createBatch(
          db,
          required(values.game, 'game'),
          required(values.batch, 'batch'),
          values.note,
          values.region,
        );
        console.log(`Created "${values.batch}". Import keys into it with the same name.`);
        break;
      case 'batch rename': {
        const r = renameBatch(
          db,
          required(values.game, 'game'),
          required(values.batch, 'batch'),
          required(values.to, 'to'),
        );
        console.log(
          r.merged
            ? `Merged into "${values.to}", moving ${r.moved} keys across.`
            : `Renamed to "${values.to}".`,
        );
        break;
      }
      case 'batch delete':
        deleteBatch(db, required(values.game, 'game'), required(values.batch, 'batch'));
        console.log(`Deleted "${values.batch}".`);
        break;
      case 'import keys':
        importKeys(db, {
          game: required(values.game, 'game'),
          batch: required(values.batch, 'batch'),
          file: required(values.file, 'file'),
          ...(values.note ? { note: values.note } : {}),
        });
        break;
      case 'import recipients':
        importRecipients(db, { file: required(values.file, 'file') });
        break;
      case 'assign':
        assign(db, {
          game: required(values.game, 'game'),
          recipient: required(values.recipient, 'recipient'),
          ...(values.campaign ? { campaign: values.campaign } : {}),
          ...(values.batch ? { batch: values.batch } : {}),
        });
        break;
      case 'check':
        await check(db, {
          game: required(values.game, 'game'),
          delayMs: Math.max(1000, Number(values.delay ?? 1500)),
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values.all ? { all: true } : {}),
          ...(values.since ? { sinceHours: Number(values.since) } : {}),
        });
        break;
      case 'scan':
        await scan(db, { game: required(values.game, 'game'), country: country(values.country) });
        break;
      case 'report':
        report(db, {
          game: required(values.game, 'game'),
          dormantDays: Number(values['dormant-days'] ?? 14),
          ...(values.json ? { json: true } : {}),
        });
        break;
      default:
        // Printing the usage alone left the person to spot which of their words
        // was the wrong one.
        console.error(`Unknown command "${[cmd, sub].filter(Boolean).join(' ')}".\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    // A plain database is already on disk; an encrypted one only exists in
    // memory until this runs.
    saveDb(db);
    db.close();
  }
}

main().catch((e: unknown) => {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exitCode = 1;
});
