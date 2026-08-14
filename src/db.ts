import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync, statSync,
} from 'node:fs';
import { isEncrypted, seal, unseal, loadKey } from './crypto.js';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  steam_appid INTEGER UNIQUE,
  itad_id     TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id         INTEGER PRIMARY KEY,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note       TEXT,
  UNIQUE (game_id, name)
);

CREATE TABLE IF NOT EXISTS keys (
  id       INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  key      TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recipients (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  email  TEXT,
  kind   TEXT NOT NULL DEFAULT 'other',
  handle TEXT,
  note   TEXT
);

-- One key, one recipient. The whole point of the tool.
CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY,
  key_id       INTEGER NOT NULL UNIQUE REFERENCES keys(id),
  recipient_id INTEGER NOT NULL REFERENCES recipients(id),
  assigned_at  TEXT NOT NULL,
  campaign     TEXT,
  note         TEXT
);

-- Append-only: we keep the history so a key flipping to 'activated' is visible.
CREATE TABLE IF NOT EXISTS activations (
  id           INTEGER PRIMARY KEY,
  key_id       INTEGER NOT NULL REFERENCES keys(id),
  checked_at   TEXT NOT NULL,
  status       TEXT NOT NULL,
  account      TEXT,
  activated_at TEXT,
  raw          TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id         INTEGER PRIMARY KEY,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  shop_id    INTEGER,
  shop_name  TEXT NOT NULL,
  price      REAL NOT NULL,
  currency   TEXT NOT NULL,
  url        TEXT,
  is_keyshop INTEGER NOT NULL DEFAULT 0,
  seen_at    TEXT NOT NULL
);

-- A key you actually found for sale. The only hard evidence in the schema:
-- everything else here is inference.
CREATE TABLE IF NOT EXISTS sightings (
  id       INTEGER PRIMARY KEY,
  key_id   INTEGER NOT NULL REFERENCES keys(id),
  shop     TEXT NOT NULL,
  price    REAL,
  currency TEXT,
  noted_at TEXT NOT NULL,
  note     TEXT
);

-- Shop logos, fetched once by the local server and kept as data URIs. The
-- browser never reaches out for them, so the page stays self-contained and no
-- resale site learns that a studio is watching it from the page itself.
CREATE TABLE IF NOT EXISTS shop_icons (
  shop       TEXT PRIMARY KEY,
  data_uri   TEXT,
  fetched_at TEXT NOT NULL
);

-- Findings you have already been shown, so an alert fires once rather than
-- every time the same problem is still true.
CREATE TABLE IF NOT EXISTS seen_findings (
  game_id     INTEGER NOT NULL REFERENCES games(id),
  fingerprint TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  PRIMARY KEY (game_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_sightings_key ON sightings(key_id);
CREATE INDEX IF NOT EXISTS idx_activations_key ON activations(key_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_listings_game   ON listings(game_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_keys_batch      ON keys(batch_id);
`;

export type Db = DatabaseSync;

/**
 * serialize and deserialize exist on DatabaseSync at runtime and are covered by
 * test/crypto.test.js, but the pinned @types/node does not declare them yet.
 * Narrowed here rather than reached through `any`, so the call sites stay
 * type-checked.
 */
interface Serialisable {
  serialize(): Uint8Array;
  deserialize(data: Uint8Array): void;
}
const bytes = (db: Db): Db & Serialisable => db as Db & Serialisable;

/**
 * Statuses that close a key's question. Redeemed means it reached someone;
 * revoked means you dealt with it. Anything else leaves the key waiting, and
 * every dormancy count in the codebase interpolates this so the four of them
 * cannot drift apart.
 */
export const SETTLED = "('activated', 'revoked')";

/**
 * How long a name is allowed to be.
 *
 * Nothing here is a security boundary: the database belongs to whoever runs the
 * tool. It is a kindness. A 200,000 character game name went in without
 * complaint and left a sidebar that could not be read or clicked, and the only
 * way back out was the command line.
 */
export const NAME_LIMIT = 200;
export const NOTE_LIMIT = 2000;

export function shortText(value: unknown, what: string, limit = NAME_LIMIT): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${what} cannot be empty.`);
  if (text.length > limit) {
    throw new Error(`${what} is ${text.length} characters. Keep it under ${limit}.`);
  }
  // Control characters survive a copy and paste from all sorts of places and
  // then break every table they land in.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
 * add them to a database that already exists, so they are applied by hand.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ['games', 'image', 'TEXT'],
  ['games', 'store_url', 'TEXT'],
  // Valve will region-lock a key package on request, which is the one measure
  // that actually limits price arbitrage. Recording which region a batch was
  // locked to lets a sighting in the wrong country mean something.
  ['batches', 'region', 'TEXT'],
  ['sightings', 'country', 'TEXT'],
];

/** The encrypted form of a database lives beside it, under the same name. */
export const sealedPath = (path: string): string => resolve(path) + '.enc';

/**
 * Databases opened from an encrypted file: where to write them back, and what
 * the file looked like when this process last saw it. Encrypted ones live in
 * memory while open, so nothing reaches disk until `saveDb` runs.
 */
interface Sealed {
  path: string;
  seen: string;
}
const SEALED = new WeakMap<Db, Sealed>();

export const isSealed = (db: Db): boolean => SEALED.has(db);

/**
 * A fingerprint of the file on disk. Every save picks a fresh random nonce, so
 * the header changes whenever anyone writes, which mtime and size can both miss
 * when two writes land in the same millisecond.
 */
function stamp(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(36);
    readSync(fd, head, 0, 36, 0);
    return head.toString('hex');
  } catch {
    return 'gone';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Writes an encrypted database back out. A no-op for a plain one, which SQLite
 * has already persisted itself.
 *
 * Every command that changes anything calls this. Encrypting on close alone
 * would mean a crash lost the session, and losing a hand-out record is the one
 * failure this tool cannot have.
 */
export function saveDb(db: Db): void {
  const sealed = SEALED.get(db);
  if (!sealed) return;

  /*
    A plain database is arbitrated by SQLite, which locks it and lets two
    processes take turns. An encrypted one is a whole file this process holds in
    memory, so writing it back blindly would erase whatever the other one did.
    Refusing is the only honest answer: the ledger is the point of the tool.
  */
  if (stamp(sealed.path) !== sealed.seen) {
    throw new Error(
      'Something else changed the database while this was open, and saving now\n' +
        'would erase it. An encrypted database can only be open in one place at a\n' +
        'time. Close the other keyward, then redo what you just did.',
    );
  }

  const key = loadKey();
  const blob = seal(Buffer.from(bytes(db).serialize()), key);
  // Written beside the target and renamed, so an interrupted write leaves the
  // previous database intact rather than half of a new one.
  const tmp = sealed.path + '.tmp';
  writeFileSync(tmp, blob, { mode: 0o600 });
  renameSync(tmp, sealed.path);
  restrictToOwner(sealed.path);
  sealed.seen = stamp(sealed.path);
}

/**
 * Cuts a file down to its owner.
 *
 * chmod is the whole story on macOS and Linux. On Windows it only toggles the
 * read-only bit, and the inherited ACL still lets other accounts read the file,
 * so the ACL has to be rewritten instead. Failure is not fatal: on a
 * single-account machine there is nobody to keep out, and refusing to open the
 * database over a permission bit would be worse than the exposure.
 */
export function restrictToOwner(file: string): void {
  if (!existsSync(file)) return; // the WAL sidecars only appear once SQLite writes
  try {
    if (process.platform === 'win32') {
      const user = process.env['USERNAME'];
      if (!user) return;
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } else {
      chmodSync(file, 0o600);
    }
  } catch {
    /* nothing here is worth failing an open over */
  }
}

/**
 * SQLite says "unable to open database file" and stops there, which covers a
 * missing directory, a permission it does not have, a folder where a file was
 * expected, and a file that is not a database at all. Any of those is worth
 * naming.
 */
function open(file: string): Db {
  try {
    const db = new DatabaseSync(file);
    // DatabaseSync opens lazily, so a file that is not a database says nothing
    // until something reads it. This is that something.
    db.exec('PRAGMA journal_mode = WAL');
    return db;
  } catch (e) {
    const why = (e as Error).message;
    if (/not a database/i.test(why)) {
      throw new Error(`${file} is not a keyward database.`);
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      throw new Error(`${file} is a folder. --db takes the path to a file.`);
    }
    throw new Error(`Cannot open ${file}: ${why}. Check that the folder exists and is writable.`);
  }
}

export function openDb(path: string): Db {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });

  const sealed = sealedPath(abs);
  if (existsSync(sealed)) {
    const blob = readFileSync(sealed);
    if (!isEncrypted(blob)) throw new Error(`${sealed} exists but is not an encrypted database.`);

    const db = new DatabaseSync(':memory:');
    bytes(db).deserialize(unseal(blob, loadKey()));
    // WAL has no meaning for a database held in memory, and a WAL header is
    // what stops a serialised file from being deserialised at all.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    applyAddedColumns(db);
    SEALED.set(db, { path: sealed, seen: stamp(sealed) });
    return db;
  }

  const db = open(abs);

  /*
    SQLite creates the file with whatever the umask allows, which is normally
    world-readable. This database is the ledger of who holds which key, so on a
    machine with more than one account it should not be. WAL and shared-memory
    sidecars carry the same content.
  */
  for (const suffix of ['', '-wal', '-shm']) restrictToOwner(abs + suffix);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  applyAddedColumns(db);
  return db;
}

function applyAddedColumns(db: Db): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const has = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Turns a plain database into an encrypted one, and back. */
export function convertDb(path: string, to: 'sealed' | 'plain', key: Buffer): void {
  const abs = resolve(path);
  const sealed = sealedPath(abs);

  if (to === 'sealed') {
    if (existsSync(sealed)) throw new Error('That database is already encrypted.');
    if (!existsSync(abs)) throw new Error(`No database at ${abs}.`);

    const src = new DatabaseSync(abs);
    // Out of WAL first: a serialised WAL database will not deserialise.
    src.exec('PRAGMA journal_mode = DELETE');
    const plain = Buffer.from(bytes(src).serialize());
    src.close();

    const tmp = sealed + '.tmp';
    writeFileSync(tmp, seal(plain, key), { mode: 0o600 });
    renameSync(tmp, sealed);
    // Only now, with the encrypted copy safely on disk.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(abs + suffix);
      } catch {
        /* the sidecars may not exist */
      }
    }
    return;
  }

  if (!existsSync(sealed)) throw new Error('That database is not encrypted.');
  if (existsSync(abs)) throw new Error(`${abs} already exists; move it out of the way first.`);

  const db = new DatabaseSync(':memory:');
  bytes(db).deserialize(unseal(readFileSync(sealed), key));
  const out = Buffer.from(bytes(db).serialize());
  db.close();

  writeFileSync(abs, out, { mode: 0o600 });
  unlinkSync(sealed);
}

export function now(): string {
  return new Date().toISOString();
}

export interface GameRow {
  id: number;
  name: string;
  steam_appid: number | null;
  itad_id: string | null;
}

export function getGame(db: Db, nameOrAppid: string): GameRow {
  const byAppid = /^\d+$/.test(nameOrAppid);
  const row = byAppid
    ? db.prepare('SELECT * FROM games WHERE steam_appid = ?').get(Number(nameOrAppid))
    : db.prepare('SELECT * FROM games WHERE name = ?').get(nameOrAppid);
  if (!row) {
    throw new Error(
      `No game matching "${nameOrAppid}". Add it with: keyward game add --name "..." --appid 123456`,
    );
  }
  return row as unknown as GameRow;
}
