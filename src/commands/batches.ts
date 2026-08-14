import { getGame, now, type Db, shortText, NOTE_LIMIT } from '../db.js';

/**
 * Batches are the unit of channel attribution: press keys in one, each
 * distributor in their own. Everything keyward can say about where a leak came
 * from rests on keys from the right batch going to the right people, so a batch
 * needs to be something you can create, name properly, and pick from when you
 * hand a key out.
 */

export interface BatchSummary {
  batch: string;
  created_at: string;
  keys: number;
  remaining: number;
  note: string | null;
  region: string | null;
}

export function listBatches(db: Db, gameName: string): BatchSummary[] {
  const game = getGame(db, gameName);
  return db
    .prepare(
      // k.id IS NOT NULL matters: the left join gives an empty batch one row of
      // nulls, and counting that as an unassigned key made empty batches report
      // a phantom key left over.
      `SELECT b.name AS batch, b.created_at, b.note, b.region,
              COUNT(k.id) AS keys,
              SUM(CASE WHEN k.id IS NOT NULL AND a.id IS NULL THEN 1 ELSE 0 END) AS remaining
         FROM batches b
         LEFT JOIN keys k ON k.batch_id = b.id
         LEFT JOIN assignments a ON a.key_id = k.id
        WHERE b.game_id = ?
        GROUP BY b.id
        ORDER BY b.created_at DESC`,
    )
    .all(game.id) as unknown as BatchSummary[];
}

export function createBatch(
  db: Db,
  gameName: string,
  name: string,
  note?: string,
  region?: string,
): void {
  const game = getGame(db, gameName);
  const clean = shortText(name, 'A batch name');
  if (note) shortText(note, 'A batch note', NOTE_LIMIT);

  const existing = db
    .prepare('SELECT id FROM batches WHERE game_id = ? AND name = ?')
    .get(game.id, clean);
  if (existing) throw new Error(`"${clean}" already exists for ${game.name}.`);

  db.prepare(
    'INSERT INTO batches (game_id, name, created_at, note, region) VALUES (?, ?, ?, ?, ?)',
  ).run(
    game.id,
    clean,
    now(),
    note?.trim() || null,
    region?.trim().toUpperCase() || null,
  );
}

/**
 * Renaming onto an existing batch merges the two. That is the point: a typo
 * during an import silently creates a second batch ("press-preveiw"), splitting
 * a channel in half and quietly weakening every rule that compares batches.
 * Merging is how you undo that.
 */
export function renameBatch(
  db: Db,
  gameName: string,
  from: string,
  to: string,
): { merged: boolean; moved: number } {
  const game = getGame(db, gameName);
  const target = to.trim();
  if (!target) throw new Error('A batch needs a name.');
  if (target === from) throw new Error('That is already its name.');

  const source = db
    .prepare('SELECT id FROM batches WHERE game_id = ? AND name = ?')
    .get(game.id, from) as { id: number } | undefined;
  if (!source) throw new Error(`No batch called "${from}" for ${game.name}.`);

  const destination = db
    .prepare('SELECT id FROM batches WHERE game_id = ? AND name = ?')
    .get(game.id, target) as { id: number } | undefined;

  if (!destination) {
    db.prepare('UPDATE batches SET name = ? WHERE id = ?').run(target, source.id);
    return { merged: false, moved: 0 };
  }

  db.exec('BEGIN');
  try {
    const moved = db
      .prepare('UPDATE keys SET batch_id = ? WHERE batch_id = ?')
      .run(destination.id, source.id).changes;
    db.prepare('DELETE FROM batches WHERE id = ?').run(source.id);
    db.exec('COMMIT');
    return { merged: true, moved: Number(moved) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Only ever removes a batch nobody put keys in. */
export function deleteBatch(db: Db, gameName: string, name: string): void {
  const game = getGame(db, gameName);
  const row = db
    .prepare(
      `SELECT b.id, COUNT(k.id) AS keys
         FROM batches b LEFT JOIN keys k ON k.batch_id = b.id
        WHERE b.game_id = ? AND b.name = ?
        GROUP BY b.id`,
    )
    .get(game.id, name) as { id: number; keys: number } | undefined;

  if (!row) throw new Error(`No batch called "${name}" for ${game.name}.`);
  if (row.keys > 0) {
    throw new Error(
      `"${name}" holds ${row.keys} keys. Rename it onto another batch to merge them instead.`,
    );
  }
  db.prepare('DELETE FROM batches WHERE id = ?').run(row.id);
}
