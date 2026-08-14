import { getGame, SETTLED, type Db } from '../db.js';

/**
 * Two questions the report never answered, both about keys nobody is chasing.
 *
 * The first is stock you are sitting on. A studio asks Valve for five thousand
 * keys and hands out two, and the other three sit in a text file on somebody's
 * desktop for a year. Those are the ones the `unassigned-activated` rule catches
 * coming back redeemed, because a leak from your own side does not need a
 * contact to leak it.
 *
 * The second is the follow-up nobody sends. keyward will tell you that a
 * journalist has held four keys for two months and then stop, which leaves the
 * useful part, writing to them, entirely up to you.
 */

export interface UnusedBatch {
  batch: string;
  unused: number;
  total: number;
  createdAt: string;
  ageDays: number;
}

export function unusedKeys(db: Db, gameName?: string): UnusedBatch[] {
  const game = gameName ? getGame(db, gameName) : null;
  return db
    .prepare(
      `SELECT b.name AS batch,
              b.created_at AS createdAt,
              CAST(julianday('now') - julianday(b.created_at) AS INTEGER) AS ageDays,
              COUNT(k.id) AS total,
              SUM(CASE WHEN a.id IS NULL THEN 1 ELSE 0 END) AS unused
         FROM batches b
         LEFT JOIN keys k ON k.batch_id = b.id
         LEFT JOIN assignments a ON a.key_id = k.id
        WHERE (? IS NULL OR b.game_id = ?)
        GROUP BY b.id
       HAVING unused > 0
        ORDER BY unused DESC, ageDays DESC`,
    )
    .all(game?.id ?? null, game?.id ?? null) as unknown as UnusedBatch[];
}

export interface Reminder {
  name: string;
  email: string | null;
  handle: string | null;
  kind: string;
  waiting: number;
  oldestDays: number;
  batches: string;
}

/**
 * Who is worth a follow-up: contacts holding keys that were checked, came back
 * unredeemed, and have sat that way for longer than `days`.
 *
 * Unchecked keys are left out on purpose. Chasing someone over a key you never
 * looked up is how a studio accuses a journalist who redeemed it on day one.
 */
export function remindList(db: Db, gameName: string, days = 14): Reminder[] {
  const game = getGame(db, gameName);
  return db
    .prepare(
      `SELECT r.name, r.email, r.handle, r.kind,
              COUNT(*) AS waiting,
              CAST(julianday('now') - julianday(MIN(a.assigned_at)) AS INTEGER) AS oldestDays,
              GROUP_CONCAT(DISTINCT b.name) AS batches
         FROM assignments a
         JOIN keys k ON k.id = a.key_id
         JOIN batches b ON b.id = k.batch_id
         JOIN recipients r ON r.id = a.recipient_id
         JOIN (SELECT key_id, status,
                      ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                 FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
          AND s.status NOT IN ${SETTLED}
          AND julianday('now') - julianday(a.assigned_at) >= ?
        GROUP BY r.id
        ORDER BY waiting DESC, oldestDays DESC`,
    )
    .all(game.id, days) as unknown as Reminder[];
}
