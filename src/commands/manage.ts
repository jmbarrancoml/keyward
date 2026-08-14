import { readFileSync } from 'node:fs';
import { getGame, now, shortText, type Db } from '../db.js';
import { looksLikeZip, zipToText } from '../unzip.js';
import { extractKeys, nearMisses, parseCsv } from '../csv.js';

/**
 * The one place a game is created, so both the CLI and the web UI refuse a
 * duplicate the same way. Without this the caller saw SQLite's own words:
 * `UNIQUE constraint failed: games.name`.
 *
 * The check ignores case, which the UNIQUE index does not. Two games differing
 * only in capitals are two games to every lookup here and one game to the person
 * typing, and that is a mess worth refusing up front.
 */
export function assertNewGame(db: Db, rawName: string): string {
  const name = shortText(rawName, 'A game name');

  const clash = db.prepare('SELECT name FROM games WHERE name = ? COLLATE NOCASE').get(name) as
    | { name: string }
    | undefined;
  if (clash) {
    throw new Error(
      clash.name === name
        ? `"${name}" is already on the list.`
        : `"${clash.name}" is already on the list, and two games cannot differ by capitals alone.`,
    );
  }
  return name;
}

export function createGame(
  db: Db,
  opts: { name: string; appid?: number | null; image?: string | null; storeUrl?: string | null },
): void {
  const name = assertNewGame(db, opts.name);

  // The appid is unique too, and letting SQLite say so produced
  // `UNIQUE constraint failed: games.steam_appid`.
  if (opts.appid != null) {
    const clash = db.prepare('SELECT name FROM games WHERE steam_appid = ?').get(opts.appid) as
      | { name: string }
      | undefined;
    if (clash) throw new Error(`Appid ${opts.appid} is already "${clash.name}".`);
  }

  db.prepare('INSERT INTO games (name, steam_appid, image, store_url) VALUES (?, ?, ?, ?)').run(
    name,
    opts.appid ?? null,
    opts.image ?? null,
    opts.storeUrl ?? null,
  );
}

export function gameAdd(db: Db, opts: { name: string; appid?: number }): void {
  createGame(db, opts);
  console.log(`Added game "${opts.name}"${opts.appid ? ` (appid ${opts.appid})` : ''}.`);
}

export function gameList(db: Db): void {
  const rows = db
    .prepare(
      `SELECT g.name, g.steam_appid,
              (SELECT COUNT(*) FROM keys k JOIN batches b ON b.id = k.batch_id WHERE b.game_id = g.id) AS keys,
              (SELECT COUNT(*) FROM assignments a JOIN keys k ON k.id = a.key_id
                 JOIN batches b ON b.id = k.batch_id WHERE b.game_id = g.id) AS assigned
         FROM games g ORDER BY g.name`,
    )
    .all() as Array<{ name: string; steam_appid: number | null; keys: number; assigned: number }>;

  if (rows.length === 0) {
    console.log('No games yet. Add one: keyward game add --name "My Game" --appid 123456');
    return;
  }
  for (const r of rows) {
    console.log(`${r.name}  appid=${r.steam_appid ?? '-'}  keys=${r.keys}  assigned=${r.assigned}`);
  }
}

export function importKeys(db: Db, opts: { game: string; batch: string; file: string; note?: string }): void {
  const raw = readFileSync(opts.file);
  const { added, total, elsewhere } = importKeysFromText(db, {
    game: opts.game,
    batch: opts.batch,
    // The download from Steamworks is a zip, so accept one rather than making
    // people unzip it first.
    text: looksLikeZip(raw) ? zipToText(raw) : raw.toString('utf8'),
    ...(opts.note ? { note: opts.note } : {}),
  });
  console.log(`Imported ${added} new keys into "${opts.batch}" (${total - added} already known).`);
  if (elsewhere.length > 0) {
    console.log(
      `  Some of those are filed under ${elsewhere.join(', ')}. Check you picked the right game.`,
    );
  }
}

export function importKeysFromText(
  db: Db,
  opts: { game: string; batch: string; text: string; note?: string },
): { added: number; total: number; elsewhere: string[] } {
  const game = getGame(db, opts.game);
  const keys = extractKeys(opts.text);
  if (keys.length === 0) {
    const close = nearMisses(opts.text);
    throw new Error(
      'No keys in there. keyward looks for the shape AAAAA-BBBBB-CCCCC anywhere in what you ' +
        'paste.' +
        (close.length
          ? ` These came close but have the wrong shape, so the copy may have been cut: ${close.join(', ')}`
          : ''),
    );
  }

  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO batches (game_id, name, created_at, note) VALUES (?, ?, ?, ?)').run(
      game.id,
      opts.batch,
      now(),
      opts.note ?? null,
    );
    const batch = db
      .prepare('SELECT id FROM batches WHERE game_id = ? AND name = ?')
      .get(game.id, opts.batch) as { id: number };

    // A key is unique across the whole database, so one already filed under a
    // different game is silently ignored here. Counting that as "already known"
    // hides a real mistake: keys pasted into the wrong game.
    const owner = db.prepare(
      `SELECT g.name FROM keys k
         JOIN batches b ON b.id = k.batch_id
         JOIN games g ON g.id = b.game_id
        WHERE k.key = ?`,
    );

    const insert = db.prepare('INSERT OR IGNORE INTO keys (batch_id, key) VALUES (?, ?)');
    let added = 0;
    const elsewhere = new Set<string>();
    for (const k of keys) {
      if (insert.run(batch.id, k).changes > 0) {
        added++;
        continue;
      }
      const row = owner.get(k) as { name: string } | undefined;
      if (row && row.name !== game.name) elsewhere.add(row.name);
    }
    db.exec('COMMIT');
    return { added, total: keys.length, elsewhere: [...elsewhere] };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function importRecipients(db: Db, opts: { file: string }): void {
  const added = importRecipientsFromText(db, readFileSync(opts.file, 'utf8'));
  console.log(`Imported ${added} new recipients.`);
}

export interface Person {
  name: string;
  email: string | null;
  kind: string;
  handle: string | null;
}

/**
 * Reads a list of people out of a CSV. Shared by `import recipients` and by
 * `handout`, which needs the same columns and would otherwise drift from it.
 */
export function readPeople(text: string): Person[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('The recipients CSV is empty.');

  const header = (rows[0] ?? []).map((h) => h.toLowerCase().trim());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iName = col('name', 'recipient', 'nombre');
  const iEmail = col('email', 'mail', 'correo');
  const iKind = col('kind', 'type', 'tipo');
  const iHandle = col('handle', 'channel', 'url', 'twitter', 'youtube');
  if (iName < 0) throw new Error('The recipients CSV needs a "name" column.');

  const people: Person[] = [];
  for (const row of rows.slice(1)) {
    const name = (row[iName] ?? '').trim();
    if (!name) continue;
    people.push({
      name,
      email: iEmail >= 0 && row[iEmail] ? row[iEmail] : null,
      kind: iKind >= 0 && row[iKind] ? row[iKind] : 'other',
      handle: iHandle >= 0 && row[iHandle] ? row[iHandle] : null,
    });
  }
  return people;
}

export function importRecipientsFromText(db: Db, text: string): number {
  const people = readPeople(text);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO recipients (name, email, kind, handle) VALUES (?, ?, ?, ?)',
  );
  let added = 0;
  for (const person of people) {
    added += insert.run(person.name, person.email, person.kind, person.handle).changes > 0
      ? 1
      : 0;
  }
  return added;
}

/**
 * Hands out one unused key to one recipient and records the pairing. Everything
 * else in keyward depends on this pairing existing, so it is the only way keys
 * are meant to leave the database.
 */
export interface AssignOptions {
  game: string;
  recipient: string;
  campaign?: string;
  batch?: string;
}

export function assignKey(db: Db, opts: AssignOptions): { key: string; recipient: string } {
  const game = getGame(db, opts.game);

  db.prepare('INSERT OR IGNORE INTO recipients (name) VALUES (?)').run(shortText(opts.recipient, 'A contact name'));
  const recipient = db.prepare('SELECT id FROM recipients WHERE name = ?').get(opts.recipient) as { id: number };

  const key = db
    .prepare(
      `SELECT k.id, k.key FROM keys k
         JOIN batches b ON b.id = k.batch_id
        WHERE b.game_id = ?
          AND (? IS NULL OR b.name = ?)
          AND k.id NOT IN (SELECT key_id FROM assignments)
        ORDER BY k.id LIMIT 1`,
    )
    .get(game.id, opts.batch ?? null, opts.batch ?? null) as { id: number; key: string } | undefined;

  if (!key) {
    // Naming the game when the caller named a batch reads as "this game is out
    // of keys", which is wrong whenever another batch still has some, and the
    // person then imports keys they did not need.
    if (opts.batch) {
      const elsewhere = db
        .prepare(
          `SELECT b.name, COUNT(*) AS n FROM keys k
             JOIN batches b ON b.id = k.batch_id
            WHERE b.game_id = ? AND b.name != ?
              AND k.id NOT IN (SELECT key_id FROM assignments)
            GROUP BY b.id ORDER BY n DESC`,
        )
        .all(game.id, opts.batch) as Array<{ name: string; n: number }>;
      throw new Error(
        `No unused keys left in "${opts.batch}".` +
          (elsewhere.length
            ? ` Still available: ${elsewhere.map((b) => `${b.name} (${b.n})`).join(', ')}.`
            : ' No other batch has any either, so import more.'),
      );
    }
    throw new Error(`No unassigned keys left for "${game.name}". Import another batch.`);
  }

  db.prepare('INSERT INTO assignments (key_id, recipient_id, assigned_at, campaign) VALUES (?, ?, ?, ?)').run(
    key.id,
    recipient.id,
    now(),
    opts.campaign ?? null,
  );
  return { key: key.key, recipient: opts.recipient };
}

export function assign(db: Db, opts: AssignOptions): void {
  const { key } = assignKey(db, opts);
  // stdout carries the key alone so it pipes into a mail merge; everything
  // human-facing goes to stderr.
  console.log(key);
  console.error(`Assigned to ${opts.recipient}${opts.campaign ? ` (campaign: ${opts.campaign})` : ''}.`);
}
