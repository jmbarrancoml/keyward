import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { gameAdd, importKeysFromText, assignKey } from '../dist/commands/manage.js';
import { createBatch } from '../dist/commands/batches.js';
import { handOut, toHandoutCsv } from '../dist/commands/handout.js';
import { unusedKeys, remindList } from '../dist/commands/hygiene.js';

const KEYS = (n, prefix = 'AAAAA') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}-ZZZZZ`).join('\n');

const LIST = 'name,email,kind\nAna,ana@example.com,press\nBob,bob@example.com,creator\nCarla,,press';

function withGame(fn, keys = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-handout-'));
  const db = openDb(join(dir, 'h.db'));
  const log = console.log;
  console.log = () => {};
  try {
    gameAdd(db, { name: 'G' });
    importKeysFromText(db, { game: 'G', batch: 'press', text: KEYS(keys) });
    return fn(db);
  } finally {
    console.log = log;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a list goes out in one go, one key each', () => {
  withGame((db) => {
    const out = handOut(db, { game: 'G', text: LIST, batch: 'press', campaign: 'launch' });
    assert.equal(out.rows.length, 3);
    assert.equal(out.newContacts, 3);
    assert.equal(out.batch, 'press');

    const keys = new Set(out.rows.map((r) => r.key));
    assert.equal(keys.size, 3, 'nobody may be given the same key as somebody else');
    assert.equal(out.rows[0].email, 'ana@example.com');
    assert.equal(out.rows[2].email, null, 'a missing email is not invented');

    // And the ledger knows, which is the entire point of doing it this way.
    const held = db
      .prepare('SELECT COUNT(*) n FROM assignments a JOIN recipients r ON r.id = a.recipient_id')
      .get().n;
    assert.equal(held, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments WHERE campaign = 'launch'").get().n, 3);
  });
});

test('a list longer than the stock changes nothing at all', () => {
  // Handing out twenty and failing on the twenty-first would leave a half-sent
  // campaign with no way to tell which half.
  withGame((db) => {
    assert.throws(
      () => handOut(db, { game: 'G', text: LIST, batch: 'press' }),
      /3 people on the list and 2 unused keys/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 0);
  }, 2);
});

test('someone already on the list keeps what you knew about them', () => {
  withGame((db) => {
    handOut(db, { game: 'G', text: 'name,email\nAna,ana@example.com' });
    const second = handOut(db, { game: 'G', text: 'name,kind\nAna,press' });
    assert.equal(second.newContacts, 0);
    const row = db.prepare("SELECT email, kind FROM recipients WHERE name = 'Ana'").get();
    assert.equal(row.email, 'ana@example.com', 'a later row without an email must not erase it');
    assert.equal(row.kind, 'press');
  });
});

test('the CSV it hands back is the one a mail merge wants', () => {
  withGame((db) => {
    const out = handOut(db, { game: 'G', text: LIST });
    const csv = toHandoutCsv(out.rows);
    assert.match(csv.split('\n')[0], /^key,name,email,kind,handle$/);
    assert.equal(csv.trim().split('\n').length, 4);
    assert.match(csv, /"Ana","ana@example.com"/);
  });
});

test('a name a spreadsheet would run is defused there too', () => {
  withGame((db) => {
    const out = handOut(db, { game: 'G', text: 'name\n=HYPERLINK("http://evil.example")' });
    assert.match(toHandoutCsv(out.rows), /"'=HYPERLINK/);
  });
});

test('stock nobody has been given is counted and aged', () => {
  withGame((db) => {
    handOut(db, { game: 'G', text: LIST });
    const [batch] = unusedKeys(db, 'G');
    assert.equal(batch.batch, 'press');
    assert.equal(batch.unused, 7);
    assert.equal(batch.total, 10);
    assert.ok(batch.ageDays >= 0);

    // A batch with nothing left stops being reported.
    handOut(db, { game: 'G', text: 'name\nD\nE\nF\nG\nH\nI\nJ' });
    assert.equal(unusedKeys(db, 'G').length, 0);
  });
});

test('the follow-up list holds only keys that were checked', () => {
  withGame((db) => {
    handOut(db, { game: 'G', text: LIST });
    db.exec("UPDATE assignments SET assigned_at = datetime('now','-40 days')");
    assert.equal(remindList(db, 'G').length, 0, 'an unchecked key is not evidence of anything');

    const keys = db.prepare('SELECT key_id FROM assignments').all();
    const ins = db.prepare(
      "INSERT INTO activations (key_id, checked_at, status) VALUES (?, datetime('now'), ?)",
    );
    ins.run(keys[0].key_id, 'not_activated');
    ins.run(keys[1].key_id, 'activated');

    const chase = remindList(db, 'G');
    assert.equal(chase.length, 1, 'only the one that came back unredeemed');
    assert.equal(chase[0].name, 'Ana');
    assert.equal(chase[0].email, 'ana@example.com');
    assert.ok(chase[0].oldestDays >= 39);

    // And the age threshold is honoured.
    assert.equal(remindList(db, 'G', 90).length, 0);
  });
});

test('a batch remembers the region it was locked to', () => {
  withGame((db) => {
    createBatch(db, 'G', 'latam', 'distributor allocation', 'mx');
    const row = db.prepare("SELECT region FROM batches WHERE name = 'latam'").get();
    assert.equal(row.region, 'MX', 'stored upper case, so a lookup never misses on case');
  });
});
