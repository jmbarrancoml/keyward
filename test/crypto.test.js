import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seal, unseal, isEncrypted, newKey, recoveryCode, parseRecoveryCode } from '../dist/crypto.js';
import { openDb, saveDb, isSealed, sealedPath, convertDb } from '../dist/db.js';
import { gameAdd, importKeysFromText, assignKey } from '../dist/commands/manage.js';

const KEY = Buffer.alloc(32, 7);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-crypto-'));
  const before = process.env.KEYWARD_DB_KEY;
  process.env.KEYWARD_DB_KEY = KEY.toString('hex');
  const log = console.log;
  console.log = () => {};
  try {
    return fn(join(dir, 'k.db'));
  } finally {
    console.log = log;
    if (before === undefined) delete process.env.KEYWARD_DB_KEY;
    else process.env.KEYWARD_DB_KEY = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

const seed = (db) => {
  gameAdd(db, { name: 'Lanternfall', appid: 1 });
  importKeysFromText(db, {
    game: 'Lanternfall',
    batch: 'press',
    text: 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF',
  });
};

test('a sealed blob gives back exactly what went in', () => {
  const plain = Buffer.from('AAAAA-BBBBB-CCCCC and the rest of the ledger');
  const blob = seal(plain, KEY);
  assert.ok(isEncrypted(blob));
  assert.equal(blob.includes('AAAAA'), false, 'the plaintext must not survive in the file');
  assert.deepEqual(unseal(blob, KEY), plain);
});

test('a wrong key and a tampered file both fail closed', () => {
  const blob = seal(Buffer.from('ledger'), KEY);
  assert.throws(() => unseal(blob, Buffer.alloc(32, 9)), /would not decrypt/);

  // Flip one bit of ciphertext. GCM has to notice.
  const bent = Buffer.from(blob);
  bent[bent.length - 1] ^= 1;
  assert.throws(() => unseal(bent, KEY), /would not decrypt/);

  assert.throws(() => unseal(Buffer.from('SQLite format 3\0'), KEY), /not an encrypted/);
});

test('a recovery code survives being read off a screen', () => {
  const key = newKey();
  const code = recoveryCode(key);
  assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4}){15}$/);
  assert.deepEqual(parseRecoveryCode(code), key);
  // Whatever the person types back: lowercase, spaces, missing dashes.
  assert.deepEqual(parseRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), key);
  assert.throws(() => parseRecoveryCode('ABCDE-ABCDE'), /64 hex/);
});

test('encrypting leaves no readable database behind', () => {
  withDir((path) => {
    const db = openDb(path);
    seed(db);
    db.close();

    convertDb(path, 'sealed', KEY);

    assert.equal(existsSync(path), false, 'the plain file has to be gone, not just copied');
    for (const suffix of ['-wal', '-shm']) {
      assert.equal(existsSync(path + suffix), false, `${suffix} would hold recent writes`);
    }
    const blob = readFileSync(sealedPath(path));
    assert.ok(isEncrypted(blob));
    assert.equal(blob.includes('AAAAA-BBBBB-CCCCC'), false);
    if (process.platform !== 'win32') {
      assert.equal(statSync(sealedPath(path)).mode & 0o777, 0o600);
    }
  });
});

test('an encrypted database is used like any other, and writes persist', () => {
  withDir((path) => {
    const first = openDb(path);
    seed(first);
    first.close();
    convertDb(path, 'sealed', KEY);

    const db = openDb(path);
    assert.ok(isSealed(db), 'openDb has to find the .enc file on its own');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keys').get().n, 2);

    assignKey(db, { game: 'Lanternfall', recipient: 'Pixel Ledger' });
    saveDb(db);
    db.close();

    const again = openDb(path);
    const row = again.prepare('SELECT name FROM recipients').get();
    assert.equal(row.name, 'Pixel Ledger', 'the write went back into the sealed file');
    again.close();
  });
});

test('without saveDb an encrypted write is lost, which is why every command calls it', () => {
  // The in-memory copy is the working database. Nothing reaches disk on its own.
  withDir((path) => {
    const first = openDb(path);
    seed(first);
    first.close();
    convertDb(path, 'sealed', KEY);

    const db = openDb(path);
    assignKey(db, { game: 'Lanternfall', recipient: 'Ghost' });
    db.close();

    const again = openDb(path);
    assert.equal(again.prepare('SELECT COUNT(*) n FROM recipients').get().n, 0);
    again.close();
  });
});

test('an encrypted database cannot run in WAL mode', () => {
  // serialize() refuses a WAL database, so getting this wrong would break
  // saving rather than fail loudly at open time.
  withDir((path) => {
    const first = openDb(path);
    seed(first);
    first.close();
    convertDb(path, 'sealed', KEY);

    const db = openDb(path);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'memory');
    saveDb(db);
    db.close();
  });
});

test('decrypting gives back a plain file with everything in it', () => {
  withDir((path) => {
    const first = openDb(path);
    seed(first);
    first.close();

    convertDb(path, 'sealed', KEY);
    convertDb(path, 'plain', KEY);

    assert.equal(existsSync(sealedPath(path)), false);
    const db = openDb(path);
    assert.equal(isSealed(db), false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM keys').get().n, 2);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
  });
});

test('the wrong key cannot open or convert an encrypted database', () => {
  withDir((path) => {
    const first = openDb(path);
    seed(first);
    first.close();
    convertDb(path, 'sealed', KEY);

    process.env.KEYWARD_DB_KEY = Buffer.alloc(32, 3).toString('hex');
    assert.throws(() => openDb(path), /would not decrypt/);
    assert.throws(() => convertDb(path, 'plain', Buffer.alloc(32, 3)), /would not decrypt/);
    // And the file is still there, unharmed.
    assert.ok(isEncrypted(readFileSync(sealedPath(path))));
  });
});

test('a second process cannot be silently overwritten', () => {
  // SQLite arbitrates a plain file. An encrypted one is held whole in memory,
  // so a blind write back would erase whatever the other keyward recorded.
  withDir((path) => {
    const first = openDb(path);
    seed(first);
    first.close();
    convertDb(path, 'sealed', KEY);

    const mine = openDb(path);
    const theirs = openDb(path);
    assignKey(theirs, { game: 'Lanternfall', recipient: 'Their Contact' });
    saveDb(theirs);
    theirs.close();

    assignKey(mine, { game: 'Lanternfall', recipient: 'My Contact' });
    assert.throws(() => saveDb(mine), /would erase it/);
    mine.close();

    const again = openDb(path);
    assert.equal(again.prepare('SELECT name FROM recipients').get().name, 'Their Contact');
    again.close();
  });
});

test('saveDb on a plain database does nothing', () => {
  withDir((path) => {
    const db = openDb(path);
    seed(db);
    saveDb(db);
    assert.equal(existsSync(sealedPath(path)), false);
    db.close();
  });
});
