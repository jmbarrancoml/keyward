import { now, type Db } from '../db.js';

/**
 * Seeds a database that looks like a real studio three months into a launch.
 *
 * Everything here is invented. That is not laziness — keyward's report names
 * people next to the phrase "may have leaked your key", so shipping demo data
 * with real outlets, real creators or a real game in those rows would be
 * putting an accusation next to a real name. The studios, the press and the
 * channels below do not exist.
 *
 * The seed is fixed, so the same command always produces the same database and
 * screenshots stay reproducible.
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Steam keys avoid vowels and confusable glyphs, so demo keys that use the same
// alphabet read as real at a glance.
const ALPHABET = 'BCDFGHJKMNPQRTVWXY2346789';

function makeKey(rnd: () => number): string {
  const group = () =>
    Array.from({ length: 5 }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

const PRESS = [
  'Pixel Ledger', 'The Backlog Report', 'Vertical Slice', 'Frame Rate Weekly',
  'Cartridge Club', 'Second Wind Mag', 'Loading Bay', 'The Quiet Level',
  'Hearth & Hex', 'Bitgrain', 'Play Register', 'The Long Save',
  'Idle Hands Press', 'Northbound Games', 'Paper Lantern Review',
];

const CREATORS = [
  'quietkeeper', 'brambleplays', 'nocluenoah', 'saltlampgames', 'threehourtutorial',
  'mossandmachine', 'lategamelena', 'thefinalsave', 'coalfireco', 'pixelpilgrim',
  'onemorerunmm', 'harborlight', 'shrikeplays', 'duskcircuit', 'tinygoblinco',
  'wanderbyte', 'thelastcheckpoint', 'emberlark', 'slowparade', 'nightferry',
  'copperkettleplays', 'thedriftwoodco', 'halfmoonhal', 'verdigrisvee', 'ninthgate',
];

const FESTIVALS = [
  'Northlight Festival', 'Indie Harbour Awards', 'Selecta Games Fest',
  'Meridian Showcase', 'Low Tide Expo',
];

const PARTNERS = [
  'Ashgrove Publishing', 'Halcyon Distribution', 'Bright Anvil Media',
  'Corvid Localisation', 'Two Rivers PR', 'Stonecrop Media',
];

/**
 * Real shop homepages. The listings themselves are invented, but the shop is
 * not — and pointing at the real origin is what lets the demo show each shop's
 * actual logo instead of a monogram.
 */
export const SHOP_URLS: Record<string, string> = {
  Steam: 'https://store.steampowered.com/',
  'Humble Store': 'https://www.humblebundle.com/store',
  GOG: 'https://www.gog.com/',
  Fanatical: 'https://www.fanatical.com/',
  'Green Man Gaming': 'https://www.greenmangaming.com/',
  'Instant Gaming': 'https://www.instant-gaming.com/',
  Gamivo: 'https://www.gamivo.com/',
  Kinguin: 'https://www.kinguin.net/',
  Eneba: 'https://www.eneba.com/',
  G2A: 'https://www.g2a.com/',
};

/** Official storefronts and keyshops, with the price spread you actually see. */
const LANTERNFALL_LISTINGS: Array<[string, number, boolean]> = [
  ['Steam', 19.99, false],
  ['Humble Store', 19.99, false],
  ['GOG', 19.99, false],
  ['Fanatical', 15.99, false],
  ['Green Man Gaming', 16.49, false],
  ['Instant Gaming', 8.99, true],
  ['Gamivo', 9.85, true],
  ['Kinguin', 9.4, true],
  ['Eneba', 10.15, true],
  ['G2A', 11.2, true],
];

const TIDEWRIGHT_LISTINGS: Array<[string, number, boolean]> = [
  ['Steam', 12.99, false],
  ['Humble Store', 12.99, false],
  ['Fanatical', 10.39, false],
];

/**
 * Cover art for the demo games, generated rather than downloaded.
 *
 * Pulling the real capsule for these appids would fetch some other studio's
 * artwork, which is the same mistake as naming a real outlet in the findings.
 * These are obviously synthetic and cost nothing.
 */
function demoArt(title: string, seed: number): string {
  const rnd = mulberry32(seed);
  const bars = Array.from({ length: 14 }, (_, i) => {
    const h = 20 + Math.floor(rnd() * 60);
    return `<rect x="${i * 17}" y="${87 - h}" width="12" height="${h}" rx="3" fill="#ffffff" opacity="${(0.06 + rnd() * 0.16).toFixed(2)}"/>`;
  }).join('');
  const initials = title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 231 87">` +
    `<rect width="231" height="87" fill="#1b1b1f"/>${bars}` +
    `<text x="16" y="54" font-family="-apple-system,Segoe UI,sans-serif" font-size="34" ` +
    `font-weight="700" fill="#f0f0f2" letter-spacing="-1">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const iso = (daysAgo: number, hour = 10): string =>
  new Date(Date.now() - daysAgo * 86_400_000 + hour * 3_600_000).toISOString();

interface BatchSpec {
  name: string;
  keys: number;
  createdDaysAgo: number;
  /** Two-letter country, when the studio asked Valve to region-lock the package. */
  region?: string;
}

export function seedDemo(db: Db): { games: number; keys: number; recipients: number } {
  const rnd = mulberry32(20260813);

  const insertGame = db.prepare(
    'INSERT INTO games (name, steam_appid, itad_id, image, store_url) VALUES (?, ?, ?, ?, ?)',
  );
  const insertBatch = db.prepare(
    'INSERT INTO batches (game_id, name, created_at, note, region) VALUES (?, ?, ?, ?, ?)',
  );
  const insertKey = db.prepare('INSERT INTO keys (batch_id, key) VALUES (?, ?)');
  const insertRecipient = db.prepare(
    'INSERT OR IGNORE INTO recipients (name, email, kind, handle) VALUES (?, ?, ?, ?)',
  );
  const insertAssignment = db.prepare(
    'INSERT INTO assignments (key_id, recipient_id, assigned_at, campaign) VALUES (?, ?, ?, ?)',
  );
  const insertActivation = db.prepare(
    'INSERT INTO activations (key_id, checked_at, status, account, activated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertListing = db.prepare(
    `INSERT INTO listings (game_id, shop_id, shop_name, price, currency, url, is_keyshop, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Recipients, tagged by the kind of contact they are.
  const recipients: Array<{ id: number; kind: string }> = [];
  const addRecipients = (names: string[], kind: string, handle: (n: string) => string | null) => {
    for (const name of names) {
      insertRecipient.run(
        name,
        `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`,
        kind,
        handle(name),
      );
      const row = db.prepare('SELECT id FROM recipients WHERE name = ?').get(name) as { id: number };
      recipients.push({ id: row.id, kind });
    }
  };
  addRecipients(PRESS, 'press', (n) => `${n.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`);
  addRecipients(CREATORS, 'creator', (n) => `@${n}`);
  addRecipients(FESTIVALS, 'festival', () => null);
  addRecipients(PARTNERS, 'partner', () => null);

  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)] as T;

  let totalKeys = 0;

  const buildGame = (
    name: string,
    appid: number,
    batches: BatchSpec[],
    opts: {
      assignRate: number;
      /** Of the assigned keys: how many end up redeemed vs left sitting. */
      activatedRate: number;
      uncheckedRate: number;
      campaign: string;
      listings: Array<[string, number, boolean]> | null;
      oldestAssignmentDays: number;
    },
  ) => {
    insertGame.run(
      name,
      appid,
      null,
      demoArt(name, appid),
      `https://store.steampowered.com/app/${appid}/`,
    );
    const game = db.prepare('SELECT id FROM games WHERE name = ?').get(name) as { id: number };

    for (const spec of batches) {
      insertBatch.run(game.id, spec.name, iso(spec.createdDaysAgo), null, spec.region ?? null);
      const batch = db
        .prepare('SELECT id FROM batches WHERE game_id = ? AND name = ?')
        .get(game.id, spec.name) as { id: number };

      for (let i = 0; i < spec.keys; i++) {
        const key = makeKey(rnd);
        insertKey.run(batch.id, key);
        totalKeys++;
        const keyRow = db.prepare('SELECT id FROM keys WHERE key = ?').get(key) as { id: number };

        if (rnd() > opts.assignRate) continue;

        const assignedDaysAgo = Math.floor(rnd() * opts.oldestAssignmentDays) + 2;
        const recipient = pick(recipients);
        insertAssignment.run(keyRow.id, recipient.id, iso(assignedDaysAgo), opts.campaign);

        const roll = rnd();
        if (roll < opts.uncheckedRate) continue; // never queried against Steamworks

        if (roll < opts.uncheckedRate + opts.activatedRate) {
          // Redeemed, usually within a few days of being sent. The account is
          // left null on purpose: Steam does not tell partners which account
          // redeemed a key, so demo data that filled that column in would be
          // showing a capability the tool does not have.
          const activatedDaysAgo = Math.max(1, assignedDaysAgo - Math.floor(rnd() * 4));
          insertActivation.run(keyRow.id, iso(1, 9), 'activated', null, iso(activatedDaysAgo, 14).slice(0, 10));
        } else {
          // Checked more than once, so the report exercises "latest wins".
          if (rnd() < 0.4) insertActivation.run(keyRow.id, iso(9, 9), 'not_activated', null, null);
          insertActivation.run(keyRow.id, iso(1, 9), 'not_activated', null, null);
        }
      }
    }

    if (opts.listings) {
      const seenAt = now();
      let shopId = 1;
      for (const [shop, price, isKeyshop] of opts.listings) {
        insertListing.run(
          game.id,
          shopId++,
          shop,
          price,
          'EUR',
          SHOP_URLS[shop] ?? null,
          isKeyshop ? 1 : 0,
          seenAt,
        );
      }
    }
  };

  // The one with a problem: heavily seeded press campaign, a pile of keys that
  // were never redeemed, and the game selling at half price on five keyshops.
  buildGame(
    'Lanternfall',
    99000001,
    [
      { name: 'press-preview', keys: 60, createdDaysAgo: 48 },
      { name: 'launch-creators', keys: 120, createdDaysAgo: 40 },
      { name: 'festival-jury', keys: 25, createdDaysAgo: 36 },
      // Region-locked, the way a distributor allocation usually is.
      { name: 'publisher-partners', keys: 35, createdDaysAgo: 30, region: 'MX' },
    ],
    {
      assignRate: 0.78,
      // This studio has already run `check`, so almost nothing is unknown.
      // A demo full of "unchecked" would make the tool look like it knows
      // nothing, which is the opposite of the point.
      activatedRate: 0.82,
      uncheckedRate: 0.04,
      campaign: 'launch',
      listings: LANTERNFALL_LISTINGS,
      oldestAssignmentDays: 44,
    },
  );

  // The story the report is meant to surface. In practice a leak is rarely one
  // reviewer with one key — it is a channel partner sitting on a block of them.
  // Nine keys to one distributor, sent five weeks ago, not one redeemed.
  const lanternfall = db.prepare("SELECT id FROM games WHERE name = 'Lanternfall'").get() as { id: number };
  const halcyon = db.prepare("SELECT id FROM recipients WHERE name = 'Halcyon Distribution'").get() as { id: number };
  const spare = db
    .prepare(
      `SELECT k.id FROM keys k
         JOIN batches b ON b.id = k.batch_id
        WHERE b.game_id = ? AND b.name = 'publisher-partners'
          AND k.id NOT IN (SELECT key_id FROM assignments)
        LIMIT 9`,
    )
    .all(lanternfall.id) as Array<{ id: number }>;

  for (const [i, k] of spare.entries()) {
    insertAssignment.run(k.id, halcyon.id, iso(35 - i, 11), 'retail-bundle');
    insertActivation.run(k.id, iso(1, 9), 'not_activated', null, null);
  }

  // The other finding worth demonstrating: keys nobody was ever given, coming
  // back redeemed. Somebody handed these out off the books, or an export went
  // somewhere it should not have. It points inside the studio, not at a
  // recipient, which is why the rules treat it separately.
  const offBooks = db
    .prepare(
      `SELECT k.id FROM keys k
         JOIN batches b ON b.id = k.batch_id
        WHERE b.game_id = ? AND b.name = 'press-preview'
          AND k.id NOT IN (SELECT key_id FROM assignments)
          AND k.id NOT IN (SELECT key_id FROM activations)
        LIMIT 3`,
    )
    .all(lanternfall.id) as Array<{ id: number }>;

  for (const [i, k] of offBooks.entries()) {
    insertActivation.run(k.id, iso(1, 9), 'activated', null, iso(28 - i * 5, 14).slice(0, 10));
  }

  // An early warning rather than a leak: a contact taking keys and redeeming
  // none of them, but recently enough that nothing counts as dormant yet.
  // Usually a dead address or an inbox nobody reads — worth knowing before you
  // send a fourth.
  insertRecipient.run('Lowtide Collective', 'hello@lowtide.example.com', 'press', 'lowtide.example');
  const lowtide = db.prepare("SELECT id FROM recipients WHERE name = 'Lowtide Collective'").get() as { id: number };
  const recent = db
    .prepare(
      `SELECT k.id FROM keys k
         JOIN batches b ON b.id = k.batch_id
        WHERE b.game_id = ? AND k.id NOT IN (SELECT key_id FROM assignments)
          AND k.id NOT IN (SELECT key_id FROM activations)
        LIMIT 4`,
    )
    .all(lanternfall.id) as Array<{ id: number }>;

  for (const [i, k] of recent.entries()) {
    insertAssignment.run(k.id, lowtide.id, iso(9 - i, 12), 'launch');
    insertActivation.run(k.id, iso(1, 9), 'not_activated', null, null);
  }

  // The healthy one: everything handed out got redeemed, nothing on keyshops.
  buildGame(
    'Tidewright',
    99000002,
    [{ name: 'press-launch', keys: 40, createdDaysAgo: 150 }],
    {
      assignRate: 0.85,
      activatedRate: 0.96,
      uncheckedRate: 0.02,
      campaign: 'tidewright-launch',
      listings: TIDEWRIGHT_LISTINGS,
      oldestAssignmentDays: 120,
    },
  );

  // The fresh one: keys imported, nothing sent, never scanned.
  buildGame(
    'Nine Lives of Ash',
    99000003,
    [{ name: 'preview-build', keys: 30, createdDaysAgo: 4 }],
    {
      assignRate: 0.1,
      activatedRate: 0.5,
      uncheckedRate: 0.5,
      campaign: 'preview',
      listings: null,
      oldestAssignmentDays: 3,
    },
  );

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo', '1')").run();

  return { games: 3, keys: totalKeys, recipients: recipients.length };
}

export function isDemo(db: Db): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'demo'").get() as
    | { value: string }
    | undefined;
  return row?.value === '1';
}
