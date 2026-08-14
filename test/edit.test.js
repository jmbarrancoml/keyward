import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { gameAdd, importKeysFromText, assignKey } from '../dist/commands/manage.js';
import { listKeys } from '../dist/commands/browse.js';
import {
  renameGame, setGameAppid, deleteGame, renameContact, editContact,
  deleteContact, deleteKey, revokeKey,
} from '../dist/commands/edit.js';
import { buildReport } from '../dist/commands/report.js';
import { ledger, toCsv } from '../dist/commands/export.js';

function withGame(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-edit-'));
  const db = openDb(join(dir, 'e.db'));
  const log = console.log;
  console.log = () => {};
  try {
    gameAdd(db, { name: 'G', appid: 1 });
    importKeysFromText(db, {
      game: 'G',
      batch: 'press',
      text: 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF\nGGGGG-HHHHH-JJJJJ',
    });
    return fn(db);
  } finally {
    console.log = log;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a typo in a game name can be corrected', () => {
  withGame((db) => {
    renameGame(db, 'G', 'Lanternfall');
    assert.equal(buildReport(db, { game: 'Lanternfall', dormantDays: 14 }).game, 'Lanternfall');
    assert.throws(() => renameGame(db, 'Lanternfall', 'Lanternfall'), /already its name/);
  });
});

test('an appid can be set later, and clearing it forgets the ITAD lookup', () => {
  withGame((db) => {
    db.prepare("UPDATE games SET itad_id = 'stale'").run();
    setGameAppid(db, 'G', 99000001);
    const row = db.prepare('SELECT steam_appid, store_url, itad_id FROM games').get();
    assert.equal(row.steam_appid, 99000001);
    assert.match(row.store_url, /99000001/);
    assert.equal(row.itad_id, null, 'a new appid means the old price lookup no longer applies');
  });
});

test('the same contact entered twice can be merged', () => {
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: 'Halcion' });
    assignKey(db, { game: 'G', recipient: 'Halcyon Distribution' });

    const r = renameContact(db, 'Halcion', 'Halcyon Distribution');
    assert.equal(r.merged, true);
    assert.equal(r.moved, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM recipients WHERE name LIKE 'Halc%'").get().n, 1);
  });
});

test('a contact can be corrected without losing their keys', () => {
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: 'Pixel Ledger' });
    editContact(db, 'Pixel Ledger', { email: 'hi@example.com', kind: 'press' });
    const row = db.prepare("SELECT email, kind FROM recipients WHERE name = 'Pixel Ledger'").get();
    assert.equal(row.email, 'hi@example.com');
    assert.equal(row.kind, 'press');
    // An empty string clears rather than storing nothing useful.
    editContact(db, 'Pixel Ledger', { email: '' });
    assert.equal(db.prepare("SELECT email FROM recipients WHERE name = 'Pixel Ledger'").get().email, null);
  });
});

test('nothing holding keys can be deleted by accident', () => {
  // Each of these would silently destroy the record the tool exists to keep.
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: 'Someone' });
    assert.throws(() => deleteContact(db, 'Someone'), /holds 1 keys/);
    assert.throws(() => deleteKey(db, 'AAAAA-BBBBB-CCCCC'), /was handed out/);
    assert.throws(() => deleteGame(db, 'G', false), /Pass --force/);

    // An unassigned key goes without argument.
    deleteKey(db, 'GGGGG-HHHHH-JJJJJ');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keys').get().n, 2);
  });
});

test('deleting a game with force takes everything under it', () => {
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: 'Someone' });
    revokeKey(db, 'AAAAA-BBBBB-CCCCC');

    const gone = deleteGame(db, 'G', true);
    assert.equal(gone.keys, 3);
    for (const table of ['games', 'batches', 'keys', 'assignments', 'activations']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table} should be empty`);
    }
  });
});

test('a revoked key stops being an open question', () => {
  // The tool named a leak and then had no way to say you had dealt with it.
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: 'Someone' });
    db.exec("UPDATE assignments SET assigned_at = datetime('now','-40 days')");
    assert.equal(buildReport(db, { game: 'G', dormantDays: 14 }).suspects.length, 1);

    const r = revokeKey(db, 'AAAAA-BBBBB-CCCCC', 'found on Instant Gaming');
    assert.match(r.url, /partner\.steamgames\.com/, 'it has to say where to actually do it');
    assert.equal(buildReport(db, { game: 'G', dormantDays: 14 }).suspects.length, 0);
  });
});

test('revoking something that is not a key is refused', () => {
  withGame((db) => {
    assert.throws(() => revokeKey(db, 'nonsense'), /not shaped like a Steam key/);
    assert.throws(() => revokeKey(db, 'ZZZZZ-ZZZZZ-ZZZZZ'), /No such key/);
  });
});

test('the ledger exports as CSV anything else can read', () => {
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: 'Pixel "quote" Ledger', campaign: 'launch' });
    const csv = toCsv(ledger(db, 'G'));
    const lines = csv.trim().split('\n');

    assert.equal(lines.length, 4, 'a header and one row per key');
    assert.match(lines[0], /^key,game,batch/);
    // Quotes inside a value are doubled, or the file breaks the first
    // spreadsheet that opens it.
    assert.match(csv, /"Pixel ""quote"" Ledger"/);
    assert.equal(ledger(db, 'G').length, 3);
  });
});

test('a game cannot be added twice, whatever the capitals', () => {
  // Both the CLI and the web UI used to hand SQLite's own words to the person
  // typing: UNIQUE constraint failed: games.name.
  withGame((db) => {
    assert.throws(() => gameAdd(db, { name: 'G' }), /already on the list/);
    assert.throws(() => gameAdd(db, { name: 'g' }), /capitals alone/);
    assert.throws(() => gameAdd(db, { name: '  ' }), /cannot be empty/);
  });
});

test('a name has a length, and control characters do not survive it', () => {
  // A 200,000 character game name went in without complaint and left a sidebar
  // that could not be read, with the command line as the only way back out.
  withGame((db) => {
    assert.throws(() => gameAdd(db, { name: 'x'.repeat(201) }), /under 200/);
    gameAdd(db, { name: 'x'.repeat(200) });

    gameAdd(db, { name: 'Lantern\u0000fall\u001b[31m' });
    const names = db.prepare('SELECT name FROM games').all().map((r) => r.name);
    assert.ok(names.includes('Lanternfall[31m'), `stored: ${JSON.stringify(names)}`);
  });
});

test('a wildcard typed into the search box is a character, not a pattern', () => {
  // % and _ mean something to LIKE. Typing one returned the whole ledger and
  // looked like a filter that had quietly done nothing.
  withGame((db) => {
    assert.equal(listKeys(db, { game: 'G', q: '' }).total, 3);
    assert.equal(listKeys(db, { game: 'G', q: '%' }).total, 0);
    assert.equal(listKeys(db, { game: 'G', q: '_' }).total, 0);
    assert.equal(listKeys(db, { game: 'G', q: 'AAAAA' }).total, 1);
  });
});

test('a cell that a spreadsheet would run is exported as text', () => {
  // Excel, LibreOffice and Sheets all evaluate a cell starting with = + - or @,
  // quoted or not. Contact names are typed by a person and shop names come from
  // an API, so neither is ours to trust.
  withGame((db) => {
    assignKey(db, { game: 'G', recipient: '=HYPERLINK("http://evil.example","click")' });
    const csv = toCsv(ledger(db, 'G'));
    assert.match(csv, /"'=HYPERLINK/, 'the formula was not defused');
    assert.doesNotMatch(csv, /,"=/, 'a cell still begins with =');
  });
});
