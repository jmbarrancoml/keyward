import { getGame, now, SETTLED, type Db } from '../db.js';
import { queryKey, sleep } from '../steamworks/client.js';

export interface CheckOptions {
  game: string;
  limit?: number;
  delayMs: number;
  /** Re-check keys already seen as activated. Off by default: activation is terminal. */
  all?: boolean;
  /**
   * Skip keys checked within this many hours. Checking thousands of keys one at
   * a time takes a while, and without this an interrupted run starts from the
   * beginning, which on a big ledger means it never finishes at all.
   */
  sinceHours?: number;
}

export type CheckEvent =
  | { type: 'progress'; done: number; total: number; key: string; status: string }
  | { type: 'change'; key: string; from: string; to: string }
  | { type: 'stopped'; key: string; message: string }
  | { type: 'done'; done: number; total: number; tally: Record<string, number> };

/**
 * Walks the studio's keys through Steamworks one at a time. Resumable by
 * design — it always picks the least recently checked keys first, so an
 * interrupted run costs nothing but the keys already done.
 */
export async function runCheck(
  db: Db,
  opts: CheckOptions,
  onEvent: (e: CheckEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const game = getGame(db, opts.game);

  const rows = db
    .prepare(
      `SELECT k.id, k.key,
              (SELECT status FROM activations a WHERE a.key_id = k.id ORDER BY a.checked_at DESC LIMIT 1) AS last_status,
              (SELECT MAX(checked_at) FROM activations a WHERE a.key_id = k.id) AS last_checked
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
        WHERE b.game_id = ?
          AND (? = 1 OR COALESCE((SELECT status FROM activations a WHERE a.key_id = k.id
                                   ORDER BY a.checked_at DESC LIMIT 1), '') NOT IN ${SETTLED})
          AND (? = 0 OR last_checked IS NULL
                     OR last_checked < datetime('now', '-' || ? || ' hours'))
        ORDER BY last_checked IS NOT NULL, last_checked ASC
        LIMIT ?`,
    )
    .all(
      game.id,
      opts.all ? 1 : 0,
      opts.sinceHours ? 1 : 0,
      opts.sinceHours ?? 0,
      opts.limit ?? 1_000_000,
    ) as Array<{
    id: number;
    key: string;
    last_status: string | null;
    last_checked: string | null;
  }>;

  const insert = db.prepare(
    'INSERT INTO activations (key_id, checked_at, status, account, activated_at, raw) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const tally: Record<string, number> = {};
  let done = 0;

  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      const details = await queryKey(row.key, signal ? { signal } : {});
      insert.run(
        row.id,
        now(),
        details.status,
        details.account ?? null,
        details.activatedAt ?? null,
        JSON.stringify(details.cells),
      );
      tally[details.status] = (tally[details.status] ?? 0) + 1;
      done++;
      // A key flipping to activated after it was assigned is normal; the
      // interesting case is the reverse, so surface state changes as we go.
      if (row.last_status && row.last_status !== details.status) {
        onEvent({ type: 'change', key: row.key, from: row.last_status, to: details.status });
      }
      onEvent({ type: 'progress', done, total: rows.length, key: row.key, status: details.status });
    } catch (e) {
      // A dead session or a rate limit will fail every remaining key, so stop
      // rather than burn through the list producing identical errors.
      onEvent({ type: 'stopped', key: row.key, message: (e as Error).message });
      break;
    }
    if (done < rows.length) await sleep(opts.delayMs, signal).catch(() => {});
  }

  onEvent({ type: 'done', done, total: rows.length, tally });
}

export async function check(db: Db, opts: CheckOptions): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  try {
    await runCheck(
      db,
      opts,
      (e) => {
        switch (e.type) {
          case 'change':
            console.error(`\n  ${e.key}: ${e.from} -> ${e.to}`);
            break;
          case 'progress':
            process.stderr.write(`\r  checked ${e.done}/${e.total}`);
            break;
          case 'stopped':
            console.error(`\nStopped at ${e.key}: ${e.message}`);
            break;
          case 'done': {
            process.stderr.write('\n');
            const summary = Object.entries(e.tally)
              .map(([k, v]) => `${k}=${v}`)
              .join('  ');
            console.log(
              e.total === 0
                ? 'Nothing to check.'
                : `Checked ${e.done} keys for "${opts.game}". ${summary || '(no results)'}`,
            );
            break;
          }
        }
      },
      controller.signal,
    );
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
