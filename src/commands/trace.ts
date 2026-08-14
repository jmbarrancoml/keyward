import { type Db } from '../db.js';
import { STEAM_KEY_RE } from '../csv.js';
import type { ActivationStatus } from '../types.js';

export type TraceVerdict =
  | 'assigned' // we know exactly who this went to
  | 'unassigned' // ours, but it never left through a recorded hand-out
  | 'unknown'; // not in this database at all

export interface TraceResult {
  key: string;
  verdict: TraceVerdict;
  game?: string;
  batch?: string;
  batchCreatedAt?: string;
  recipient?: string;
  recipientKind?: string;
  handle?: string;
  email?: string;
  campaign?: string;
  assignedAt?: string;
  status?: ActivationStatus | null;
  lastChecked?: string | null;
}

/**
 * The one move that turns keyward's shortlist into a name.
 *
 * A keyshop listing never shows the key, so nothing can be matched against it
 * from the outside. But the listing will sell you one — for the price of the
 * game — and the moment you hold that key it stops being anonymous: it is a key
 * you generated, so it is in your batches and, if you handed it out through
 * keyward, in your assignment ledger.
 *
 * One purchase, one paste, one name. That is the whole idea.
 */
export function traceKey(db: Db, rawKey: string): TraceResult {
  const key = rawKey.trim().toUpperCase();
  if (!STEAM_KEY_RE.test(key)) {
    throw new Error(`"${rawKey.trim()}" is not shaped like a Steam key (AAAAA-BBBBB-CCCCC).`);
  }

  const row = db
    .prepare(
      `SELECT g.name AS game, b.name AS batch, b.created_at AS batch_created,
              r.name AS recipient, r.kind AS recipient_kind, r.handle, r.email,
              a.campaign, a.assigned_at,
              s.status, s.checked_at
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
         JOIN games g ON g.id = b.game_id
         LEFT JOIN assignments a ON a.key_id = k.id
         LEFT JOIN recipients r ON r.id = a.recipient_id
         LEFT JOIN (SELECT key_id, status, checked_at,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE k.key = ?`,
    )
    .get(key) as
    | {
        game: string;
        batch: string;
        batch_created: string;
        recipient: string | null;
        recipient_kind: string | null;
        handle: string | null;
        email: string | null;
        campaign: string | null;
        assigned_at: string | null;
        status: ActivationStatus | null;
        checked_at: string | null;
      }
    | undefined;

  if (!row) return { key, verdict: 'unknown' };

  const base: TraceResult = {
    key,
    verdict: row.recipient ? 'assigned' : 'unassigned',
    game: row.game,
    batch: row.batch,
    batchCreatedAt: row.batch_created,
    status: row.status,
    lastChecked: row.checked_at,
  };

  if (row.recipient) {
    base.recipient = row.recipient;
    if (row.recipient_kind) base.recipientKind = row.recipient_kind;
    if (row.handle) base.handle = row.handle;
    if (row.email) base.email = row.email;
    if (row.campaign) base.campaign = row.campaign;
    if (row.assigned_at) base.assignedAt = row.assigned_at;
  }
  return base;
}

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : 'unknown');

/**
 * Records that this key was actually found for sale. Everything else in keyward
 * is inference; this is the one thing a studio can state as fact, so it is
 * worth keeping rather than living in whoever ran the trace.
 */
export function recordSighting(
  db: Db,
  key: string,
  shop: string,
  price?: number,
  currency?: string,
  /**
   * Where you bought it. Only matters for region-locked batches, where a key
   * sold outside its region is the arbitrage the lock exists to stop.
   */
  country?: string,
): void {
  const row = db.prepare('SELECT id FROM keys WHERE key = ?').get(key.trim().toUpperCase()) as
    | { id: number }
    | undefined;
  if (!row) throw new Error('That key is not in this database, so there is nothing to record it against.');
  db.prepare(
    'INSERT INTO sightings (key_id, shop, price, currency, noted_at, country) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    shop,
    price ?? null,
    currency ?? null,
    new Date().toISOString(),
    country?.trim().toUpperCase() || null,
  );
}

export function trace(
  db: Db,
  rawKey: string,
  json = false,
  seenOn?: string,
  country?: string,
): void {
  const r = traceKey(db, rawKey);

  if (seenOn && r.verdict !== 'unknown') {
    recordSighting(db, r.key, seenOn, undefined, undefined, country);
  }
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`\n${r.key}`);

  if (r.verdict === 'unknown') {
    console.log('\n  No record of this key.');
    console.log('\n  Either you never imported it, or it belongs to someone else. Shops often');
    console.log('  sell stock they bought cheap in another region, and some list games they');
    console.log('  cannot actually supply. Query the key in Steamworks to tell those apart.');
    return;
  }

  if (seenOn) console.log(`  recorded as seen on ${seenOn}`);
  console.log(`  ${r.game}  ·  batch "${r.batch}" created ${day(r.batchCreatedAt)}`);
  console.log(`  status: ${r.status ?? 'never checked'}${r.lastChecked ? ` (as of ${day(r.lastChecked)})` : ''}`);

  if (r.verdict === 'unassigned') {
    console.log('\n  Yours, but you never handed it out through keyward.');
    console.log('\n  No contact of yours leaked this one. Check where your key exports went,');
    console.log('  who has the spreadsheet, and who can generate keys on your Steamworks');
    console.log('  account.');
    return;
  }

  console.log(
    `\n  Sent to ${r.recipient}${r.handle ? ` <${r.handle}>` : ''}` +
      `${r.recipientKind ? ` (${r.recipientKind})` : ''} on ${day(r.assignedAt)}` +
      `${r.campaign ? `, campaign "${r.campaign}"` : ''}.`,
  );
  console.log('\n  You made this key and your own records say who got it. Two things before');
  console.log('  you act on that:');
  console.log('    - a reseller may have bought it fairly from someone further down the');
  console.log('      chain, so this tells you where it left your hands, not who made');
  console.log('      money on it;');
  console.log('    - revoking it takes the game away from whoever paid for it, and they');
  console.log('      are your customer too.');
  console.log('  Most of the time you want a conversation with whoever holds the contract.');
}
