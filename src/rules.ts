import { SETTLED, type Db } from './db.js';

/**
 * Rules turn the raw ledger into signals worth looking at.
 *
 * Two things they deliberately are not. They are not a score that ranks people:
 * a signal names a recipient because their keys behaved oddly, which is a
 * reason to ask, not a finding of fault. And they are not thresholds tuned to
 * catch someone — every one is adjustable, because the right value depends on
 * how a studio hands keys out, and a rule that fires on everybody is noise.
 *
 * Severity is about how much of the gap between "odd" and "certain" the rule
 * closes, not about how angry to be:
 *
 *   certain  a key of yours was found for sale. Evidence, not inference.
 *   high     the pattern has no innocent reading that fits the numbers.
 *   medium   worth a question. Usually explained by something mundane.
 *   low      context. Not a finding on its own.
 */
export type Severity = 'certain' | 'high' | 'medium' | 'low';

export const SEVERITY_ORDER: Record<Severity, number> = { certain: 0, high: 1, medium: 2, low: 3 };

export interface Thresholds {
  /** Days after which an unredeemed assigned key counts as dormant. */
  dormantDays: number;
  /** Dormant keys held by one recipient before it reads as a pattern. */
  clusterMin: number;
  /** Keys a recipient must hold before a 0% redemption rate means anything. */
  neverRedeemsMin: number;
  /** Batch dormancy rate, in percent, that marks it as a hotspot. */
  batchRatePct: number;
  /** Keys held by one recipient before the concentration is worth reviewing. */
  oversuppliedMin: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  dormantDays: 14,
  clusterMin: 3,
  neverRedeemsMin: 3,
  batchRatePct: 25,
  oversuppliedMin: 10,
};

export interface Finding {
  rule: string;
  severity: Severity;
  /** What the finding is about: a person, a batch, or the studio itself. */
  subject: string;
  subjectKind: 'recipient' | 'batch' | 'studio';
  /** One line stating the fact. No interpretation. */
  summary: string;
  /** Why this pattern is worth a look, and what would explain it innocently. */
  why: string;
  count: number;
  keys: string[];
}

export interface RuleInfo {
  id: string;
  severity: Severity;
  title: string;
  description: string;
}

export const RULES: RuleInfo[] = [
  {
    id: 'confirmed-on-sale',
    severity: 'certain',
    title: 'Key found for sale',
    description:
      'A key you found on a resale site and wrote down with `keyward trace --seen-on`. Every ' +
      'other rule below is a guess. This one is something you saw.',
  },
  {
    id: 'region-mismatch',
    severity: 'certain',
    title: 'A region-locked key turned up somewhere else',
    description:
      'You found a key on sale in a country its batch was not locked to. Region locking is the ' +
      'one measure that limits price arbitrage, so a key crossing that line did not get there ' +
      'by accident.',
  },
  {
    id: 'unassigned-activated',
    severity: 'high',
    title: 'Redeemed without ever being handed out',
    description:
      'Keys came back redeemed that you never gave to anyone. No contact of yours leaked these, ' +
      'so check where your key exports went, who has the spreadsheet, and who else can generate ' +
      'keys on your Steamworks account.',
  },
  {
    id: 'dormant-cluster',
    severity: 'high',
    title: 'Several unredeemed keys, one holder',
    description:
      'One contact holding several keys they have never redeemed. Anyone forgets one key. A ' +
      'block of them from the same person is how a leaking channel looks.',
  },
  {
    id: 'never-redeems',
    severity: 'medium',
    title: 'Never redeems anything',
    description:
      'Someone has taken several keys and redeemed none of them. Usually a dead address or a ' +
      'shared inbox nobody reads, which you want to know before you send a fourth.',
  },
  {
    id: 'batch-hotspot',
    severity: 'medium',
    title: 'One batch bleeding harder than the rest',
    description:
      'A batch with far more unredeemed keys than the others for this game. Look there before ' +
      'you look at any one person.',
  },
  {
    id: 'oversupplied',
    severity: 'low',
    title: 'Unusual concentration of keys',
    description:
      'One recipient holding a large share of a game\'s keys. Normal for a distributor, worth ' +
      'a second look for a reviewer.',
  },
];

interface RecipientStat {
  recipient: string;
  handle: string | null;
  kind: string;
  assigned: number;
  redeemed: number;
  dormant: number;
  dormant_keys: string | null;
  keys: string | null;
}

const split = (s: string | null, limit = 12): string[] =>
  s ? s.split(',').filter(Boolean).slice(0, limit) : [];

export function evaluateRules(db: Db, gameId: number, t: Thresholds): Finding[] {
  const cutoff = new Date(Date.now() - t.dormantDays * 86_400_000).toISOString();
  const findings: Finding[] = [];

  // --- certain: a key we actually found on sale -----------------------------
  const sighted = db
    .prepare(
      `SELECT COALESCE(r.name, '(never handed out)') AS recipient, r.handle, r.kind,
              GROUP_CONCAT(k.key) AS keys, COUNT(*) AS n,
              GROUP_CONCAT(DISTINCT si.shop) AS shops
         FROM sightings si
         JOIN keys k ON k.id = si.key_id
         JOIN batches b ON b.id = k.batch_id
         LEFT JOIN assignments a ON a.key_id = k.id
         LEFT JOIN recipients r ON r.id = a.recipient_id
        WHERE b.game_id = ?
        GROUP BY r.id
        ORDER BY n DESC`,
    )
    .all(gameId) as Array<{
    recipient: string;
    handle: string | null;
    kind: string | null;
    keys: string | null;
    n: number;
    shops: string | null;
  }>;

  for (const s of sighted) {
    findings.push({
      rule: 'confirmed-on-sale',
      severity: 'certain',
      subject: s.recipient,
      subjectKind: s.recipient === '(never handed out)' ? 'studio' : 'recipient',
      summary:
        `${s.n} key${s.n === 1 ? '' : 's'} traced to ${s.recipient} ` +
        `found for sale on ${s.shops ?? 'a keyshop'}.`,
      why:
        'You saw this one yourself. A reseller may still have bought it from someone further ' +
        'down the chain, so it tells you where the key left your hands, not who made money on it.',
      count: s.n,
      keys: split(s.keys),
    });
  }

  /*
    A sighting in a country the batch was not locked to.

    This one is as solid as confirmed-on-sale, because both rest on something a
    person saw and wrote down. It only fires when the batch has a region and the
    sighting has a country, so it stays quiet for everyone who does not use
    region locking.
  */
  const crossed = db
    .prepare(
      `SELECT b.name AS batch, b.region, si.country, si.shop,
              COUNT(*) AS n, GROUP_CONCAT(k.key) AS keys,
              COALESCE(r.name, '(never handed out)') AS recipient
         FROM sightings si
         JOIN keys k ON k.id = si.key_id
         JOIN batches b ON b.id = k.batch_id
         LEFT JOIN assignments a ON a.key_id = k.id
         LEFT JOIN recipients r ON r.id = a.recipient_id
        WHERE b.game_id = ?
          AND b.region IS NOT NULL AND b.region != ''
          AND si.country IS NOT NULL AND si.country != ''
          AND UPPER(si.country) != UPPER(b.region)
        GROUP BY b.id, si.country
        ORDER BY n DESC`,
    )
    .all(gameId) as Array<{
    batch: string;
    region: string;
    country: string;
    shop: string;
    n: number;
    keys: string | null;
    recipient: string;
  }>;

  for (const c of crossed) {
    findings.push({
      rule: 'region-mismatch',
      severity: 'certain',
      subject: c.batch,
      subjectKind: 'batch',
      summary:
        `${c.n} key${c.n === 1 ? '' : 's'} from "${c.batch}", locked to ${c.region.toUpperCase()}, ` +
        `found on sale in ${c.country.toUpperCase()} on ${c.shop}.`,
      why:
        'A region-locked key sold outside its region had to be moved there by someone. That is ' +
        'the arbitrage the lock exists to stop, and it points at the batch rather than at a ' +
        'person, since a shop can buy through a chain of hands.',
      count: c.n,
      keys: split(c.keys),
    });
  }

  // --- high: activated, but never handed out --------------------------------
  const orphan = db
    .prepare(
      `SELECT COUNT(*) AS n, GROUP_CONCAT(k.key) AS keys
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
         LEFT JOIN assignments a ON a.key_id = k.id
         JOIN (SELECT key_id, status,
                      ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                 FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ? AND a.id IS NULL AND s.status = 'activated'`,
    )
    .get(gameId) as { n: number; keys: string | null };

  if (orphan.n > 0) {
    findings.push({
      rule: 'unassigned-activated',
      severity: 'high',
      subject: 'Keys never handed out',
      subjectKind: 'studio',
      summary: `${orphan.n} key${orphan.n === 1 ? ' was' : 's were'} redeemed without ever being assigned to anyone.`,
      why:
        'You never sent these to anyone, so no contact of yours leaked them. Check who can ' +
        'generate keys in Steamworks and where your key exports went. If someone on the team ' +
        'hands keys out without recording it here, it looks exactly like this, so ask around first.',
      count: orphan.n,
      keys: split(orphan.keys),
    });
  }

  // --- per-recipient rules --------------------------------------------------
  const stats = db
    .prepare(
      `SELECT r.name AS recipient, r.handle, r.kind,
              COUNT(*) AS assigned,
              SUM(CASE WHEN s.status = 'activated' THEN 1 ELSE 0 END) AS redeemed,
              SUM(CASE WHEN a.assigned_at < ? AND COALESCE(s.status,'unchecked') NOT IN ${SETTLED}
                       THEN 1 ELSE 0 END) AS dormant,
              GROUP_CONCAT(CASE WHEN a.assigned_at < ? AND COALESCE(s.status,'unchecked') NOT IN ${SETTLED}
                                THEN k.key END) AS dormant_keys,
              GROUP_CONCAT(k.key) AS keys
         FROM assignments a
         JOIN keys k ON k.id = a.key_id
         JOIN batches b ON b.id = k.batch_id
         JOIN recipients r ON r.id = a.recipient_id
         LEFT JOIN (SELECT key_id, status,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
        GROUP BY r.id`,
    )
    .all(cutoff, cutoff, gameId) as unknown as RecipientStat[];

  for (const s of stats) {
    const who = s.handle ? `${s.recipient} <${s.handle}>` : s.recipient;

    if (s.dormant >= t.clusterMin) {
      findings.push({
        rule: 'dormant-cluster',
        severity: 'high',
        subject: s.recipient,
        subjectKind: 'recipient',
        summary: `${who} holds ${s.dormant} unredeemed keys out of ${s.assigned}.`,
        why:
          `Anyone forgets one key. ${s.dormant} from the same contact is how a leaking channel ` +
          'looks. Ask them before you conclude anything: distributors often redeem late, or pass ' +
          'keys on inside their own company.',
        count: s.dormant,
        keys: split(s.dormant_keys),
      });
    } else if (s.assigned >= t.neverRedeemsMin && s.redeemed === 0) {
      findings.push({
        rule: 'never-redeems',
        severity: 'medium',
        subject: s.recipient,
        subjectKind: 'recipient',
        summary: `${who} has had ${s.assigned} keys and redeemed none.`,
        why:
          'Usually a dead address or a shared inbox nobody reads. Stop sending to them and find ' +
          'out which it is before you read anything else into it.',
        count: s.assigned,
        keys: split(s.keys),
      });
    }

    if (s.assigned >= t.oversuppliedMin) {
      findings.push({
        rule: 'oversupplied',
        severity: 'low',
        subject: s.recipient,
        subjectKind: 'recipient',
        summary: `${who} holds ${s.assigned} keys${s.kind ? ` (${s.kind})` : ''}.`,
        why:
          'Normal for a distributor, odd for a reviewer. Holding a lot of keys does no harm by ' +
          'itself. It sets what one leak would cost you.',
        count: s.assigned,
        keys: [],
      });
    }
  }

  // --- batch hotspot --------------------------------------------------------
  const batches = db
    .prepare(
      `SELECT b.name AS batch,
              SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
              SUM(CASE WHEN a.id IS NOT NULL AND a.assigned_at < ?
                        AND COALESCE(s.status,'unchecked') NOT IN ${SETTLED} THEN 1 ELSE 0 END) AS dormant
         FROM batches b
         JOIN keys k ON k.batch_id = b.id
         LEFT JOIN assignments a ON a.key_id = k.id
         LEFT JOIN (SELECT key_id, status,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE b.game_id = ?
        GROUP BY b.id`,
    )
    .all(cutoff, gameId) as Array<{ batch: string; assigned: number; dormant: number }>;

  const totalAssigned = batches.reduce((n, b) => n + b.assigned, 0);
  const totalDormant = batches.reduce((n, b) => n + b.dormant, 0);
  const average = totalAssigned > 0 ? totalDormant / totalAssigned : 0;

  for (const b of batches) {
    if (b.assigned < 5) continue; // too few to mean anything
    const rate = b.dormant / b.assigned;
    // Both tests have to pass: a high rate in a game where everything is high
    // is not a hotspot, and being double a tiny average is not either.
    if (rate * 100 >= t.batchRatePct && rate >= average * 1.8) {
      findings.push({
        rule: 'batch-hotspot',
        severity: 'medium',
        subject: b.batch,
        subjectKind: 'batch',
        summary:
          `Batch "${b.batch}" is ${Math.round(rate * 100)}% dormant against ` +
          `${Math.round(average * 100)}% across the game.`,
        why:
          'Keys leak from one channel at a time. Start with this batch, and keep one batch per ' +
          'channel so the next one is this easy to spot.',
        count: b.dormant,
        keys: [],
      });
    }
  }

  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count,
  );
}
