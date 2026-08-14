import { getGame, now, type Db } from '../db.js';
import { STEAM_KEY_RE } from '../csv.js';

/**
 * Correcting and closing things off.
 *
 * Until this existed, keyward only ever added: a game with a typo in its name, a
 * batch imported against the wrong title, a contact whose address you got wrong,
 * all permanent. A ledger you cannot correct stops being a ledger and becomes a
 * pile.
 *
 * Deleting anything that holds keys asks for `force`, because the interesting
 * mistakes are the ones you make in a hurry.
 */

export function renameGame(db: Db, from: string, to: string): void {
  const game = getGame(db, from);
  const name = to.trim();
  if (!name) throw new Error('A game needs a name.');
  if (name === game.name) throw new Error('That is already its name.');
  if (db.prepare('SELECT 1 FROM games WHERE name = ?').get(name)) {
    throw new Error(`"${name}" already exists. Games are not merged, because their keys are not interchangeable.`);
  }
  db.prepare('UPDATE games SET name = ? WHERE id = ?').run(name, game.id);
}

export function setGameAppid(db: Db, gameName: string, appid: number | null): void {
  const game = getGame(db, gameName);
  if (appid !== null && !Number.isInteger(appid)) throw new Error('The appid must be a whole number.');
  db.prepare('UPDATE games SET steam_appid = ?, store_url = ?, itad_id = NULL WHERE id = ?').run(
    appid,
    appid === null ? null : `https://store.steampowered.com/app/${appid}/`,
    game.id,
  );
}

export interface GameContents {
  keys: number;
  assigned: number;
  batches: number;
}

export function gameContents(db: Db, gameName: string): GameContents {
  const game = getGame(db, gameName);
  return db
    .prepare(
      `SELECT COUNT(k.id) AS keys,
              SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
              COUNT(DISTINCT b.id) AS batches
         FROM batches b
         LEFT JOIN keys k ON k.batch_id = b.id
         LEFT JOIN assignments a ON a.key_id = k.id
        WHERE b.game_id = ?`,
    )
    .get(game.id) as unknown as GameContents;
}

export function deleteGame(db: Db, gameName: string, force: boolean): GameContents {
  const game = getGame(db, gameName);
  const held = gameContents(db, gameName);
  if (held.keys > 0 && !force) {
    throw new Error(
      `"${game.name}" holds ${held.keys} keys across ${held.batches} batches, ` +
        `${held.assigned} of them handed out. Deleting it throws away that record. Pass --force if you mean it.`,
    );
  }

  db.exec('BEGIN');
  try {
    const scope = `SELECT k.id FROM keys k JOIN batches b ON b.id = k.batch_id WHERE b.game_id = ${game.id}`;
    db.exec(`DELETE FROM sightings   WHERE key_id IN (${scope})`);
    db.exec(`DELETE FROM activations WHERE key_id IN (${scope})`);
    db.exec(`DELETE FROM assignments WHERE key_id IN (${scope})`);
    db.exec(`DELETE FROM keys        WHERE id     IN (${scope})`);
    db.prepare('DELETE FROM batches       WHERE game_id = ?').run(game.id);
    db.prepare('DELETE FROM listings      WHERE game_id = ?').run(game.id);
    db.prepare('DELETE FROM seen_findings WHERE game_id = ?').run(game.id);
    db.prepare('DELETE FROM games         WHERE id = ?').run(game.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return held;
}

/** Renaming onto an existing contact merges them, the way batches do. */
export function renameContact(db: Db, from: string, to: string): { merged: boolean; moved: number } {
  const name = to.trim();
  if (!name) throw new Error('A contact needs a name.');
  if (name === from) throw new Error('That is already their name.');

  const source = db.prepare('SELECT id FROM recipients WHERE name = ?').get(from) as
    | { id: number }
    | undefined;
  if (!source) throw new Error(`No contact called "${from}".`);

  const target = db.prepare('SELECT id FROM recipients WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (!target) {
    db.prepare('UPDATE recipients SET name = ? WHERE id = ?').run(name, source.id);
    return { merged: false, moved: 0 };
  }

  db.exec('BEGIN');
  try {
    const moved = db
      .prepare('UPDATE assignments SET recipient_id = ? WHERE recipient_id = ?')
      .run(target.id, source.id).changes;
    db.prepare('DELETE FROM recipients WHERE id = ?').run(source.id);
    db.exec('COMMIT');
    return { merged: true, moved: Number(moved) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function editContact(
  db: Db,
  name: string,
  fields: { email?: string; kind?: string; handle?: string; note?: string },
): void {
  const row = db.prepare('SELECT id FROM recipients WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`No contact called "${name}".`);

  const sets: string[] = [];
  const values: Array<string | null> = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    // An empty string clears the field rather than storing nothing useful.
    values.push(value.trim() || null);
  }
  if (sets.length === 0) throw new Error('Nothing to change.');
  db.prepare(`UPDATE recipients SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id);
}

export function deleteContact(db: Db, name: string): void {
  const row = db
    .prepare(
      `SELECT r.id, COUNT(a.id) AS held
         FROM recipients r LEFT JOIN assignments a ON a.recipient_id = r.id
        WHERE r.name = ? GROUP BY r.id`,
    )
    .get(name) as { id: number; held: number } | undefined;
  if (!row) throw new Error(`No contact called "${name}".`);
  if (row.held > 0) {
    throw new Error(
      `"${name}" holds ${row.held} keys. Deleting them would leave those keys with nobody's name ` +
        'on them, which is the one thing keyward exists to prevent. Rename them onto another ' +
        'contact to merge instead.',
    );
  }
  db.prepare('DELETE FROM recipients WHERE id = ?').run(row.id);
}

/** Removes a key that was never handed out. Ones that were stay on the record. */
export function deleteKey(db: Db, rawKey: string): void {
  const key = rawKey.trim().toUpperCase();
  const row = db
    .prepare(
      `SELECT k.id, a.id AS assigned FROM keys k
         LEFT JOIN assignments a ON a.key_id = k.id WHERE k.key = ?`,
    )
    .get(key) as { id: number; assigned: number | null } | undefined;
  if (!row) throw new Error('No such key in this database.');
  if (row.assigned) {
    throw new Error('That key was handed out. Its record is the point; it stays.');
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sightings WHERE key_id = ?').run(row.id);
    db.prepare('DELETE FROM activations WHERE key_id = ?').run(row.id);
    db.prepare('DELETE FROM keys WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Records that you revoked a key in Steamworks.
 *
 * keyward cannot revoke anything: Valve gives no API for it, and you do it on
 * their site. What it can do is stop treating the key as an open question, and
 * remember why you closed it. Without this the tool named a leak and then left
 * you with no way to say you had dealt with it.
 */
export function revokeKey(db: Db, rawKey: string, reason?: string): { key: string; url: string } {
  const key = rawKey.trim().toUpperCase();
  if (!STEAM_KEY_RE.test(key)) throw new Error(`"${rawKey.trim()}" is not shaped like a Steam key.`);

  const row = db.prepare('SELECT id FROM keys WHERE key = ?').get(key) as { id: number } | undefined;
  if (!row) throw new Error('No such key in this database.');

  db.prepare(
    'INSERT INTO activations (key_id, checked_at, status, raw) VALUES (?, ?, ?, ?)',
  ).run(row.id, now(), 'revoked', reason?.trim() ? JSON.stringify([reason.trim()]) : null);

  return {
    key,
    url: `https://partner.steamgames.com/querycdkey/cdkey?cdkey=${encodeURIComponent(key)}&method=Query`,
  };
}
