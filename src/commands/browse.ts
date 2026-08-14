import { getGame, SETTLED, type Db } from '../db.js';
import type { ActivationStatus } from '../types.js';

/**
 * The report answers "is anything wrong". These answer "let me look at
 * everything", which is a different job: no thresholds, no inference, just the
 * ledger as it stands.
 */

export type KeyFilter = 'all' | 'redeemed' | 'waiting' | 'unchecked' | 'unassigned';

export interface KeyRow {
  key: string;
  batch: string;
  status: ActivationStatus | 'unchecked';
  recipient: string | null;
  handle: string | null;
  campaign: string | null;
  assigned_at: string | null;
  sighted: number;
}

export interface KeyPage {
  rows: KeyRow[];
  total: number;
  shown: number;
}

const FILTERS: Record<KeyFilter, string> = {
  all: '1=1',
  redeemed: "COALESCE(s.status,'unchecked') = 'activated'",
  // Checked, and neither redeemed nor revoked: still an open question.
  waiting: `a.id IS NOT NULL AND s.status IS NOT NULL AND s.status NOT IN ${SETTLED}`,
  unchecked: "COALESCE(s.status,'unchecked') = 'unchecked'",
  unassigned: 'a.id IS NULL',
};

/**
 * Sorting happens here rather than in the page: the browser only ever holds a
 * capped slice, so sorting that slice would silently reorder a fraction of the
 * data and look like the whole answer.
 */
export type KeySort = 'key' | 'recipient' | 'batch' | 'sent' | 'status';

const SORTS: Record<KeySort, string> = {
  key: 'k.key',
  recipient: 'r.name',
  batch: 'b.name',
  sent: 'a.assigned_at',
  status: "COALESCE(s.status, 'unchecked')",
};

/**
 * % and _ are wildcards to LIKE. Typing one into the search box meant "match
 * anything", so searching for a single % returned the entire ledger and looked
 * like a filter that had done nothing.
 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

export function listKeys(
  db: Db,
  opts: { game: string; filter?: KeyFilter; q?: string; limit?: number; sort?: KeySort; desc?: boolean },
): KeyPage {
  const game = getGame(db, opts.game);
  /*
    Object.hasOwn, not a truthiness check on the lookup.

    `FILTERS['__proto__']` is Object.prototype, which is truthy, so a request
    asking to filter by __proto__ got all the way to the SQL as the string
    "[object Object]" and came back as `no such column`. Same for the sort
    column. Both of these are interpolated into the query, so the only safe
    rule is that the name has to be one this file wrote down.
  */
  const filter: KeyFilter = opts.filter && Object.hasOwn(FILTERS, opts.filter) ? opts.filter : 'all';
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);
  const q = (opts.q ?? '').trim().toUpperCase();
  const sort: KeySort = opts.sort && Object.hasOwn(SORTS, opts.sort) ? opts.sort : 'sent';
  const dir = opts.desc === false ? 'ASC' : 'DESC';

  const where = `
    FROM keys k
    JOIN batches b ON b.id = k.batch_id
    LEFT JOIN assignments a ON a.key_id = k.id
    LEFT JOIN recipients r ON r.id = a.recipient_id
    LEFT JOIN (SELECT key_id, status,
                      ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                 FROM activations) s ON s.key_id = k.id AND s.rn = 1
   WHERE b.game_id = ?
     AND ${FILTERS[filter]}
     AND (? = '' OR k.key LIKE ? ESCAPE '\\'
              OR UPPER(r.name) LIKE ? ESCAPE '\\'
              OR UPPER(b.name) LIKE ? ESCAPE '\\')`;

  const like = `%${escapeLike(q)}%`;
  const args = [game.id, q, like, like, like];

  const total = (db.prepare(`SELECT COUNT(*) AS n ${where}`).get(...args) as { n: number }).n;

  const rows = db
    .prepare(
      `SELECT k.key, b.name AS batch,
              COALESCE(s.status, 'unchecked') AS status,
              r.name AS recipient, r.handle, a.campaign, a.assigned_at,
              (SELECT COUNT(*) FROM sightings si WHERE si.key_id = k.id) AS sighted
         ${where}
        ORDER BY ${SORTS[sort]} IS NULL, ${SORTS[sort]} ${dir}, k.key
        LIMIT ?`,
    )
    .all(...args, limit) as unknown as KeyRow[];

  return { rows, total, shown: rows.length };
}

export interface ContactRow {
  name: string;
  kind: string;
  handle: string | null;
  email: string | null;
  keys: number;
  redeemed: number;
  waiting: number;
  last_sent: string | null;
}

/** Per-contact rollup for one game: how many they got, how many they used. */
export function listContacts(db: Db, gameName: string): ContactRow[] {
  const game = getGame(db, gameName);
  return db
    .prepare(
      `SELECT r.name, r.kind, r.handle, r.email,
              COUNT(*) AS keys,
              SUM(CASE WHEN s.status = 'activated' THEN 1 ELSE 0 END) AS redeemed,
              SUM(CASE WHEN s.status IS NOT NULL AND s.status NOT IN ${SETTLED}
                       THEN 1 ELSE 0 END) AS waiting,
              MAX(a.assigned_at) AS last_sent
         FROM assignments a
         JOIN keys k ON k.id = a.key_id
         JOIN batches b ON b.id = k.batch_id
         JOIN recipients r ON r.id = a.recipient_id
         LEFT JOIN (SELECT key_id, status,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
        GROUP BY r.id
        ORDER BY waiting DESC, keys DESC, r.name`,
    )
    .all(game.id) as unknown as ContactRow[];
}
