import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { gameAdd, importKeysFromText, assignKey } from '../dist/commands/manage.js';
import { createBatch, renameBatch, deleteBatch, listBatches } from '../dist/commands/batches.js';
import { buildReport } from '../dist/commands/report.js';

function withGame(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-batch-'));
  const db = openDb(join(dir, 'b.db'));
  const log = console.log;
  console.log = () => {};
  try {
    gameAdd(db, { name: 'G', appid: 1 });
    return fn(db);
  } finally {
    console.log = log;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const load = (db, batch, keys) => importKeysFromText(db, { game: 'G', batch, text: keys.join('\n') });

test('a key is taken from the batch you name, not whichever was imported first', () => {
  // This is the whole point of batches. Handing a journalist a key out of the
  // distributor's batch destroys the channel attribution everything rests on.
  withGame((db) => {
    load(db, 'press', ['AAAAA-AAAAA-AAAAA', 'BBBBB-BBBBB-BBBBB']);
    load(db, 'distributor', ['CCCCC-CCCCC-CCCCC']);

    const { key } = assignKey(db, { game: 'G', recipient: 'Some Outlet', batch: 'distributor' });
    assert.equal(key, 'CCCCC-CCCCC-CCCCC');
  });
});

test('running a batch dry says so instead of silently taking from another', () => {
  withGame((db) => {
    load(db, 'press', ['AAAAA-AAAAA-AAAAA']);
    load(db, 'distributor', ['CCCCC-CCCCC-CCCCC']);
    assignKey(db, { game: 'G', recipient: 'One', batch: 'press' });

    // Naming the game here would read as "this game is out of keys", which is
    // false while the distributor batch still has one.
    assert.throws(
      () => assignKey(db, { game: 'G', recipient: 'Two', batch: 'press' }),
      /No unused keys left in "press"[\s\S]*distributor \(1\)/,
    );
    // The distributor key is still there, untouched.
    assert.equal(assignKey(db, { game: 'G', recipient: 'Two', batch: 'distributor' }).key, 'CCCCC-CCCCC-CCCCC');
  });
});

test('a batch can exist before its keys do', () => {
  withGame((db) => {
    createBatch(db, 'G', 'festival-jury', 'Northlight, submitted 2 June');
    const [b] = listBatches(db, 'G');
    assert.equal(b.batch, 'festival-jury');
    assert.equal(b.keys, 0);
    // The left join hands an empty batch a row of nulls; counting that as a
    // spare key made an empty batch claim it had one left.
    assert.equal(b.remaining, 0, 'an empty batch has nothing left in it');
    assert.equal(b.note, 'Northlight, submitted 2 June');

    // And an empty batch still shows up in the report, or you could not fill it.
    const { batches } = buildReport(db, { game: 'G', dormantDays: 14 });
    assert.ok(batches.some((x) => x.batch === 'festival-jury'));
  });
});

test('the same batch name is refused rather than quietly duplicated', () => {
  withGame((db) => {
    createBatch(db, 'G', 'press');
    assert.throws(() => createBatch(db, 'G', 'press'), /already exists/);
  });
});

test('renaming onto an existing batch merges them', () => {
  // A typo during an import creates a second batch and splits a channel in
  // half, which weakens every rule that compares batches. Merging undoes it.
  withGame((db) => {
    load(db, 'press-preview', ['AAAAA-AAAAA-AAAAA', 'BBBBB-BBBBB-BBBBB']);
    load(db, 'press-preveiw', ['CCCCC-CCCCC-CCCCC']);

    const r = renameBatch(db, 'G', 'press-preveiw', 'press-preview');
    assert.equal(r.merged, true);
    assert.equal(r.moved, 1);

    const batches = listBatches(db, 'G');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].keys, 3);
  });
});

test('renaming to a free name just renames', () => {
  withGame((db) => {
    load(db, 'press', ['AAAAA-AAAAA-AAAAA']);
    const r = renameBatch(db, 'G', 'press', 'press-launch');
    assert.equal(r.merged, false);
    assert.equal(listBatches(db, 'G')[0].batch, 'press-launch');
  });
});

test('a batch holding keys cannot be deleted out from under them', () => {
  withGame((db) => {
    load(db, 'press', ['AAAAA-AAAAA-AAAAA']);
    assert.throws(() => deleteBatch(db, 'G', 'press'), /holds 1 keys/);
    // An empty one goes without complaint.
    createBatch(db, 'G', 'scratch');
    deleteBatch(db, 'G', 'scratch');
    assert.equal(listBatches(db, 'G').length, 1);
  });
});

test('the report counts what is left in each batch', () => {
  withGame((db) => {
    load(db, 'press', ['AAAAA-AAAAA-AAAAA', 'BBBBB-BBBBB-BBBBB', 'CCCCC-CCCCC-CCCCC']);
    assignKey(db, { game: 'G', recipient: 'Outlet', batch: 'press' });

    const [b] = buildReport(db, { game: 'G', dormantDays: 14 }).batches;
    assert.equal(b.remaining, 2, 'you need to know how many press keys are left');
    assert.equal(b.assigned, 1);
  });
});
