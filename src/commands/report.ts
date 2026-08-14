import { getGame, SETTLED, type Db } from '../db.js';
import type { ActivationStatus } from '../types.js';
import { evaluateRules, SEVERITY_ORDER, type Finding, type Thresholds } from '../rules.js';
import { thresholds } from '../config.js';
import { shopIcons } from '../itad/icons.js';
import { unseenFindings } from '../alerts.js';

export interface ReportOptions {
  game: string;
  /** Days after which an unactivated assigned key is treated as dormant. */
  dormantDays: number;
  json?: boolean;
}

export interface SuspectRow {
  key: string;
  recipient: string;
  handle: string | null;
  campaign: string | null;
  batch: string;
  assigned_at: string;
  last_status: ActivationStatus | null;
}

export interface KeyshopListing {
  shop_name: string;
  price: number;
  currency: string;
  url: string | null;
}

export interface BatchRow {
  batch: string;
  created_at: string;
  /** Two-letter country, when the package was region-locked at Valve. */
  region: string | null;
  keys: number;
  assigned: number;
  dormant: number;
  /** Keys still in the batch. "How many press keys are left" has no other home. */
  remaining: number;
}

export interface ReportData {
  game: string;
  totals: {
    keys: number;
    assigned: number | null;
    /**
     * Handed-out keys never queried against Steam. Distinct from the overall
     * unchecked count, which includes keys still sitting in the batch — saying
     * "29 of the keys you handed out" when only four went out is the kind of
     * figure that makes someone stop believing the rest of the screen.
     */
    uncheckedAssigned: number;
  };
  statuses: Array<{ status: string; n: number }>;
  lastScan: string | null;
  keyshopListings: KeyshopListing[];
  suspects: SuspectRow[];
  batches: BatchRow[];
  findings: Finding[];
  /** Of those, the ones you have not been shown yet. */
  unseen: number;
  thresholds: Thresholds;
  /** Shop name to a data URI, for the shops that have a logo cached. */
  icons: Record<string, string>;
  /**
   * Who holds each key named in a finding. The key component shows the person
   * under the code, so it needs this alongside the findings themselves.
   */
  keyOwners: Record<string, string | null>;
}

/**
 * The inference keyward can and cannot make:
 *
 *   CAN  — this key was assigned to this person, and it has still not been
 *          activated N days later, while the game is being listed on keyshops.
 *   CANNOT — that *this* key is the one on sale at that keyshop.
 *
 * Nothing in the Steam key format is visible to a marketplace listing, so
 * attribution is a shortlist, never a proof. Every surface that renders this
 * data says so, because a tool that overstates it gets a studio to burn a real
 * reviewer.
 */
export function buildReport(db: Db, opts: ReportOptions): ReportData {
  const game = getGame(db, opts.game);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS keys,
              SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS assigned
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
         LEFT JOIN assignments a ON a.key_id = k.id
        WHERE b.game_id = ?`,
    )
    .get(game.id) as { keys: number; assigned: number | null };

  const uncheckedAssigned = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM assignments a
           JOIN keys k ON k.id = a.key_id
           JOIN batches b ON b.id = k.batch_id
          WHERE b.game_id = ?
            AND NOT EXISTS (SELECT 1 FROM activations x WHERE x.key_id = k.id)`,
      )
      .get(game.id) as { n: number }
  ).n;

  const statuses = db
    .prepare(
      `SELECT COALESCE(s.status, 'unchecked') AS status, COUNT(*) AS n
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
         LEFT JOIN (SELECT key_id, status,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
        GROUP BY 1 ORDER BY n DESC`,
    )
    .all(game.id) as Array<{ status: string; n: number }>;

  const lastScan = db
    .prepare('SELECT MAX(seen_at) AS at FROM listings WHERE game_id = ?')
    .get(game.id) as { at: string | null };

  const keyshopListings = lastScan.at
    ? (db
        .prepare(
          `SELECT shop_name, price, currency, url FROM listings
            WHERE game_id = ? AND seen_at = ? AND is_keyshop = 1 ORDER BY price ASC`,
        )
        .all(game.id, lastScan.at) as unknown as KeyshopListing[])
    : [];

  const cutoff = new Date(Date.now() - opts.dormantDays * 86_400_000).toISOString();

  /**
   * Provenance without buying anything. A key on a keyshop cannot be matched
   * from the outside, but leaks are not spread evenly across a studio's
   * channels — one batch bleeds and the rest are fine. Comparing dormancy per
   * batch points at the channel before any money is spent tracing a key.
   */
  const batches = db
    .prepare(
      `SELECT b.name AS batch, b.created_at, b.region,
              COUNT(k.id) AS keys,
              SUM(CASE WHEN k.id IS NOT NULL AND a.id IS NULL THEN 1 ELSE 0 END) AS remaining,
              SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
              SUM(CASE WHEN a.id IS NOT NULL AND a.assigned_at < ?
                        AND COALESCE(s.status, 'unchecked') NOT IN ${SETTLED}
                       THEN 1 ELSE 0 END) AS dormant
         FROM batches b
         LEFT JOIN keys k ON k.batch_id = b.id
         LEFT JOIN assignments a ON a.key_id = k.id
         LEFT JOIN (SELECT key_id, status,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
        GROUP BY b.id
        ORDER BY dormant * 1.0 / MAX(assigned, 1) DESC, dormant DESC`,
    )
    .all(cutoff, game.id) as unknown as BatchRow[];

  const suspects = db
    .prepare(
      `SELECT k.key, r.name AS recipient, r.handle, a.campaign, b.name AS batch, a.assigned_at, s.status AS last_status
         FROM assignments a
         JOIN keys k ON k.id = a.key_id
         JOIN batches b ON b.id = k.batch_id
         JOIN recipients r ON r.id = a.recipient_id
         LEFT JOIN (SELECT key_id, status,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
          AND a.assigned_at < ?
          AND COALESCE(s.status, 'unchecked') NOT IN ${SETTLED}
        ORDER BY a.assigned_at ASC`,
    )
    .all(game.id, cutoff) as unknown as SuspectRow[];

  const t = thresholds({ dormantDays: opts.dormantDays });
  const findings = evaluateRules(db, game.id, t);

  const named = [...new Set(findings.flatMap((f) => f.keys))];
  const keyOwners: Record<string, string | null> = {};
  if (named.length > 0) {
    const rows = db
      .prepare(
        `SELECT k.key, r.name
           FROM keys k
           LEFT JOIN assignments a ON a.key_id = k.id
           LEFT JOIN recipients r ON r.id = a.recipient_id
          WHERE k.key IN (${named.map(() => '?').join(',')})`,
      )
      .all(...named) as Array<{ key: string; name: string | null }>;
    for (const row of rows) keyOwners[row.key] = row.name;
  }

  return {
    game: game.name,
    totals: { ...totals, uncheckedAssigned },
    statuses,
    lastScan: lastScan.at,
    keyshopListings,
    suspects,
    batches,
    findings,
    unseen: unseenFindings(db, game.id, findings).length,
    thresholds: t,
    icons: shopIcons(db),
    keyOwners,
  };
}

export const CAVEAT =
  'Treat this as a shortlist. A shop listing never shows you the key behind it, and a key ' +
  'someone has not redeemed usually means they forgot. Ask them before you revoke anything, ' +
  'and never accuse anyone on this alone.';

export function report(db: Db, opts: ReportOptions): void {
  const data = buildReport(db, opts);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

  // Plain words rather than the status column names, which read like a
  // database dump to anyone who did not write the schema.
  const WORD: Record<string, string> = {
    activated: 'redeemed',
    not_activated: 'not redeemed',
    unchecked: 'never checked',
    revoked: 'revoked',
    invalid: 'not recognised',
    unknown: 'unclear',
  };

  console.log(`\n${data.game}`);
  console.log(`  ${data.totals.keys} keys, ${data.totals.assigned ?? 0} handed out to someone named`);
  console.log(`  ${data.statuses.map((s) => `${s.n} ${WORD[s.status] ?? s.status}`).join(', ')}`);

  console.log(`\nOn resale sites${data.lastScan ? ` (checked ${data.lastScan.slice(0, 10)})` : ''}:`);
  if (!data.lastScan) {
    console.log('  you have not looked yet. Run: keyward scan --game "..."');
  } else if (data.keyshopListings.length === 0) {
    console.log('  nobody is reselling it, as far as IsThereAnyDeal can see.');
  } else {
    for (const l of data.keyshopListings) {
      console.log(`  ${l.price.toFixed(2)} ${l.currency}  ${l.shop_name}${l.url ? `  ${l.url}` : ''}`);
    }
  }

  if (data.findings.length > 0) {
    console.log('\nWhat we noticed:');
    for (const f of data.findings) {
      console.log(`  [${f.severity.padEnd(7)}] ${f.summary}`);
      console.log(`             ${f.why.replace(/(.{66}) /g, '$1\n             ')}`);
      if (f.keys.length > 0) console.log(`             ${f.keys.slice(0, 4).join('  ')}${f.keys.length > 4 ? '  …' : ''}`);
      console.log();
    }
  }

  if (data.batches.length > 1) {
    console.log('\nBy batch (keys leak from one channel at a time, so start with the worst):');
    for (const b of data.batches) {
      const rate = b.assigned > 0 ? Math.round((b.dormant / b.assigned) * 100) : 0;
      console.log(
        `  ${String(rate).padStart(3)}%  ${String(b.dormant).padStart(3)}/${String(b.assigned).padEnd(4)} dormant` +
          `  ${b.batch}`,
      );
    }
  }

  console.log(
    `\nSent over ${opts.dormantDays} days ago and still not redeemed: ${data.suspects.length}`,
  );
  for (const s of data.suspects) {
    console.log(
      `  ${s.key}  ${s.recipient}${s.handle ? ` <${s.handle}>` : ''}` +
        `  ${days(s.assigned_at)}d  ${WORD[s.last_status ?? 'unchecked'] ?? s.last_status}` +
        `${s.campaign ? `  [${s.campaign}]` : ''}`,
    );
  }

  if (data.suspects.length > 0 && data.keyshopListings.length > 0) {
    console.log(
      `\n${data.suspects.length} keys you handed out have never been redeemed, and ` +
        `${data.keyshopListings.length} resale sites are selling the game. Put those together and ` +
        'you have somewhere to start looking.',
    );
  }
  console.log(`\n${CAVEAT.replace(/(.{78}) /g, '$1\n')}`);
}
