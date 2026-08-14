import { getGame, now, shortText, type Db } from '../db.js';
import { readPeople } from './manage.js';

/**
 * Handing out a whole list at once, and getting back what you need to send it.
 *
 * Assigning one key at a time matches nothing anybody does. A studio has a list
 * of forty journalists and needs forty key-and-person pairs to put through a
 * mail merge. Doing that here means the ledger is a by-product of sending rather
 * than homework afterwards, which is the difference between a tool people keep
 * using and a spreadsheet they go back to.
 */

export interface HandoutRow {
  key: string;
  name: string;
  email: string | null;
  kind: string;
  handle: string | null;
}

export interface HandoutResult {
  rows: HandoutRow[];
  batch: string;
  /** People who were not already in the ledger. */
  newContacts: number;
}

export function handOut(
  db: Db,
  opts: { game: string; text: string; batch?: string; campaign?: string },
): HandoutResult {
  const game = getGame(db, opts.game);
  const people = readPeople(opts.text);
  if (people.length === 0) throw new Error('No people in that list.');

  /*
    Count the stock before writing anything. Handing out twenty keys and then
    failing on the twenty-first would leave the caller with a half-sent campaign
    and no way to tell which half.
  */
  const stock = db
    .prepare(
      `SELECT b.name AS batch, COUNT(*) AS n
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
        WHERE b.game_id = ?
          AND (? IS NULL OR b.name = ?)
          AND k.id NOT IN (SELECT key_id FROM assignments)
        GROUP BY b.id
        ORDER BY n DESC`,
    )
    .all(game.id, opts.batch ?? null, opts.batch ?? null) as Array<{ batch: string; n: number }>;

  const available = stock.reduce((sum, b) => sum + b.n, 0);
  if (available < people.length) {
    const where = opts.batch ? `"${opts.batch}"` : `"${game.name}"`;
    throw new Error(
      `${people.length} people on the list and ${available} unused keys in ${where}. ` +
        `Import ${people.length - available} more, or send this list in parts.`,
    );
  }

  const upsert = db.prepare(
    `INSERT INTO recipients (name, email, kind, handle) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         email  = COALESCE(excluded.email, recipients.email),
         kind   = CASE WHEN recipients.kind = 'other' THEN excluded.kind ELSE recipients.kind END,
         handle = COALESCE(excluded.handle, recipients.handle)`,
  );
  const known = db.prepare('SELECT 1 FROM recipients WHERE name = ?');
  const takeKey = db.prepare(
    `SELECT k.id, k.key, b.name AS batch FROM keys k
       JOIN batches b ON b.id = k.batch_id
      WHERE b.game_id = ?
        AND (? IS NULL OR b.name = ?)
        AND k.id NOT IN (SELECT key_id FROM assignments)
      ORDER BY k.id LIMIT 1`,
  );
  const assign = db.prepare(
    'INSERT INTO assignments (key_id, recipient_id, assigned_at, campaign) VALUES (?, ?, ?, ?)',
  );

  const rows: HandoutRow[] = [];
  let newContacts = 0;
  let batchUsed = opts.batch ?? '';

  db.exec('BEGIN');
  try {
    for (const person of people) {
      const name = shortText(person.name, 'A contact name');
      if (!known.get(name)) newContacts += 1;
      upsert.run(name, person.email, person.kind, person.handle);
      const recipient = db.prepare('SELECT id FROM recipients WHERE name = ?').get(name) as { id: number };

      const key = takeKey.get(game.id, opts.batch ?? null, opts.batch ?? null) as
        | { id: number; key: string; batch: string }
        | undefined;
      // The count above says this cannot happen. If it ever does, the whole
      // thing rolls back rather than leaving a campaign half sent.
      if (!key) throw new Error('Ran out of keys partway through. Nothing was handed out.');

      assign.run(key.id, recipient.id, now(), opts.campaign ?? null);
      batchUsed = key.batch;
      rows.push({
        key: key.key,
        name,
        email: person.email,
        kind: person.kind,
        handle: person.handle,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { rows, batch: batchUsed, newContacts };
}

const COLUMNS = ['key', 'name', 'email', 'kind', 'handle'] as const;

/** Same quoting rules as the ledger export, including defusing formulas. */
function cell(value: unknown): string {
  const text = String(value ?? '');
  const quoted = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${quoted.replace(/"/g, '""')}"`;
}

export function toHandoutCsv(rows: HandoutRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => cell(row[c])).join(','));
  return lines.join('\n') + '\n';
}
