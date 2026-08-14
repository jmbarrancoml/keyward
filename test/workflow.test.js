import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, now } from '../dist/db.js';
import { gameAdd, importKeys, importKeysFromText, importRecipients, assign } from '../dist/commands/manage.js';
import { report } from '../dist/commands/report.js';
import { extractKeys } from '../dist/csv.js';
import { isKeyshop } from '../dist/itad/client.js';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-test-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    return fn(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs a command with its output captured, returning what it printed to stdout. */
function capture(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = () => {};
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join('\n');
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

test('extracts keys from a Steamworks-style CSV regardless of column order', () => {
  const csv = 'Package,Key,Notes\n"Press 2026",AAAAA-BBBBB-CCCCC,for press\n"Press 2026",DDDDD-EEEEE-FFFFF-GGGGG,\n';
  assert.deepEqual(extractKeys(csv), ['AAAAA-BBBBB-CCCCC', 'DDDDD-EEEEE-FFFFF-GGGGG']);
});

test('finds keys in whatever shape someone pastes', () => {
  // Requiring a key to be a whole CSV cell silently dropped every one of these,
  // and the dialog meanwhile promised that anything key-shaped would be found.
  const shapes = {
    'one per line': 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF',
    'separated by spaces': 'AAAAA-BBBBB-CCCCC DDDDD-EEEEE-FFFFF',
    'a bulleted list': '- AAAAA-BBBBB-CCCCC\n- DDDDD-EEEEE-FFFFF',
    'semicolons, as Excel exports here': 'Lote;Clave\npress;AAAAA-BBBBB-CCCCC\npress;DDDDD-EEEEE-FFFFF',
    'tabs, pasted from a spreadsheet': 'press\tAAAAA-BBBBB-CCCCC\npress\tDDDDD-EEEEE-FFFFF',
  };
  for (const [what, text] of Object.entries(shapes)) {
    assert.deepEqual(extractKeys(text), ['AAAAA-BBBBB-CCCCC', 'DDDDD-EEEEE-FFFFF'], what);
  }

  // Out of the middle of a forwarded email.
  assert.deepEqual(extractKeys('Hi! Your key is aaaaa-bbbbb-ccccc, enjoy.'), ['AAAAA-BBBBB-CCCCC']);
  // The same key twice, in different case, is one key.
  assert.deepEqual(extractKeys('AAAAA-BBBBB-CCCCC\naaaaa-bbbbb-ccccc'), ['AAAAA-BBBBB-CCCCC']);
});

test('does not invent keys out of things that merely look like them', () => {
  // Scanning loose text earns this test: a false key would be imported, handed
  // to someone, and never work.
  for (const [what, text] of Object.entries({
    'an email address': 'name,email\nAlice,alice@example.com',
    'a UUID': '550e8400-e29b-41d4-a716-446655440000',
    'a commit hash': 'commit 9f2a1c4d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'six-character groups': 'ABCDEF-GHIJKL-MNOPQR',
    'a longer group in front': 'AAAAAA-BBBBB-CCCCC',
    'ordinary prose': 'Please send the press keys to the usual list.',
  })) {
    assert.deepEqual(extractKeys(text), [], what);
  }
});

test('classifies keyshops but leaves official stores alone', () => {
  assert.equal(isKeyshop('Kinguin'), true);
  assert.equal(isKeyshop('Instant Gaming'), true);
  assert.equal(isKeyshop('G2A'), true);
  assert.equal(isKeyshop('Steam'), false);
  assert.equal(isKeyshop('Humble Store'), false);
  assert.equal(isKeyshop('GOG'), false);
});

test('a key can only be assigned to one recipient', () =>
  withDb((db, dir) => {
    capture(() => gameAdd(db, { name: 'Test Game', appid: 999 }));
    const file = join(dir, 'keys.txt');
    writeFileSync(file, 'AAAAA-BBBBB-CCCCC\n');
    capture(() => importKeys(db, { game: 'Test Game', batch: 'press', file }));

    capture(() => assign(db, { game: 'Test Game', recipient: 'Alice' }));
    // Only one key existed, so the second hand-out has nothing left to give
    // rather than quietly reusing Alice's key.
    assert.throws(
      () => capture(() => assign(db, { game: 'Test Game', recipient: 'Bob' })),
      /No unassigned keys/,
    );
  }));

test('report flags a dormant assigned key and names who got it', () =>
  withDb((db, dir) => {
    capture(() => gameAdd(db, { name: 'Test Game', appid: 999 }));

    const keyFile = join(dir, 'keys.txt');
    writeFileSync(keyFile, 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF\n');
    capture(() => importKeys(db, { game: 'Test Game', batch: 'press', file: keyFile }));

    const recipientFile = join(dir, 'recipients.csv');
    writeFileSync(recipientFile, 'name,email,kind,handle\nAlice,a@example.com,creator,@alice\n');
    capture(() => importRecipients(db, { file: recipientFile }));

    capture(() => assign(db, { game: 'Test Game', recipient: 'Alice', campaign: 'launch' }));
    capture(() => assign(db, { game: 'Test Game', recipient: 'Bob', campaign: 'launch' }));

    // Backdate both hand-outs past the dormancy window.
    db.exec(`UPDATE assignments SET assigned_at = '${daysAgo(30)}'`);

    // Alice redeemed hers; Bob's is still sitting there.
    const alice = db
      .prepare(
        `SELECT k.id FROM keys k JOIN assignments a ON a.key_id = k.id
           JOIN recipients r ON r.id = a.recipient_id WHERE r.name = 'Alice'`,
      )
      .get();
    db.prepare(
      'INSERT INTO activations (key_id, checked_at, status, account) VALUES (?, ?, ?, ?)',
    ).run(alice.id, now(), 'activated', 'aliceonsteam');

    const out = capture(() => report(db, { game: 'Test Game', dormantDays: 14, json: true }));
    const parsed = JSON.parse(out);

    assert.equal(parsed.suspects.length, 1);
    assert.equal(parsed.suspects[0].recipient, 'Bob');
    assert.equal(parsed.totals.keys, 2);
    assert.equal(parsed.totals.assigned, 2);
  }));

test('the most recent activation status wins over older ones', () =>
  withDb((db, dir) => {
    capture(() => gameAdd(db, { name: 'Test Game', appid: 999 }));
    const keyFile = join(dir, 'keys.txt');
    writeFileSync(keyFile, 'AAAAA-BBBBB-CCCCC\n');
    capture(() => importKeys(db, { game: 'Test Game', batch: 'press', file: keyFile }));
    capture(() => assign(db, { game: 'Test Game', recipient: 'Alice' }));
    db.exec(`UPDATE assignments SET assigned_at = '${daysAgo(30)}'`);

    const key = db.prepare('SELECT id FROM keys LIMIT 1').get();
    const insert = db.prepare(
      'INSERT INTO activations (key_id, checked_at, status) VALUES (?, ?, ?)',
    );
    insert.run(key.id, daysAgo(20), 'not_activated');
    insert.run(key.id, daysAgo(1), 'activated');

    const parsed = JSON.parse(
      capture(() => report(db, { game: 'Test Game', dormantDays: 14, json: true })),
    );
    assert.equal(parsed.suspects.length, 0, 'a key redeemed later must stop being a suspect');
  }));

test('report survives a game that has never been scanned', () =>
  withDb((db) => {
    capture(() => gameAdd(db, { name: 'Fresh Game', appid: 1 }));
    const out = capture(() => report(db, { game: 'Fresh Game', dormantDays: 14 }));
    assert.match(out, /not looked yet/i, 'it must say the prices were never checked');
  }));

test('a key already filed under another game is called out, not counted as known', () => {
  // keys.key is unique across the database, so importing into the wrong game
  // silently does nothing. Reporting it as "already known" hid the mistake.
  withDb((db, dir) => {
    capture(() => gameAdd(db, { name: 'A', appid: 1 }));
    capture(() => gameAdd(db, { name: 'B', appid: 2 }));
    const text = 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF';

    const first = importKeysFromText(db, { game: 'A', batch: 'press', text });
    assert.equal(first.added, 2);
    assert.deepEqual(first.elsewhere, []);

    const second = importKeysFromText(db, { game: 'B', batch: 'press', text });
    assert.equal(second.added, 0);
    assert.deepEqual(second.elsewhere, ['A'], 'it has to name the game holding them');
  });
});

test('an import that finds nothing says what came close', () => {
  withDb((db) => {
    capture(() => gameAdd(db, { name: 'A', appid: 1 }));
    assert.throws(
      () => importKeysFromText(db, { game: 'A', batch: 'x', text: 'AAAAA-BBB\nDDDD-EEEEE-FFF' }),
      /DDDD-EEEEE-FFF/,
      'a truncated paste should be shown back, not left a mystery',
    );
  });
});
