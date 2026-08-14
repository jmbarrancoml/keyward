import { getGame, now, type Db } from '../db.js';
import { lookupByAppid, pricesFor, isKeyshop, ItadError } from '../itad/client.js';
import { refreshShopIcons } from '../itad/icons.js';

export interface ScanResult {
  game: string;
  total: number;
  keyshops: Array<{ shopName: string; price: number; currency: string; url: string | null }>;
}

/**
 * Records where the game is currently on sale. This never touches a keyshop
 * directly: everything comes from the IsThereAnyDeal API, which aggregates them
 * already. No scraping, no terms-of-service grey area, no IP bans.
 */
export async function runScan(db: Db, opts: { game: string; country: string }): Promise<ScanResult> {
  const game = getGame(db, opts.game);

  let itadId = game.itad_id;
  if (!itadId) {
    if (!game.steam_appid) {
      throw new Error(`"${game.name}" has no Steam appid, so its prices cannot be looked up.`);
    }
    itadId = await lookupByAppid(game.steam_appid);
    if (!itadId) throw new Error(`IsThereAnyDeal does not know appid ${game.steam_appid} yet.`);
    db.prepare('UPDATE games SET itad_id = ? WHERE id = ?').run(itadId, game.id);
  }

  const prices = await pricesFor(itadId, opts.country);
  const seenAt = now();
  const insert = db.prepare(
    `INSERT INTO listings (game_id, shop_id, shop_name, price, currency, url, is_keyshop, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const keyshops: ScanResult['keyshops'] = [];
  for (const p of prices) {
    const keyshop = isKeyshop(p.shopName);
    if (keyshop) keyshops.push({ shopName: p.shopName, price: p.price, currency: p.currency, url: p.url });
    insert.run(game.id, p.shopId, p.shopName, p.price, p.currency, p.url, keyshop ? 1 : 0, seenAt);
  }

  keyshops.sort((a, b) => a.price - b.price);

  // Best-effort: a logo that will not load must never fail a scan.
  try {
    await refreshShopIcons(db, prices.map((p) => ({ shopName: p.shopName, url: p.url })));
  } catch {
    /* the monogram is the fallback */
  }

  return { game: game.name, total: prices.length, keyshops };
}

export async function scan(db: Db, opts: { game: string; country: string }): Promise<void> {
  let r: ScanResult;
  try {
    r = await runScan(db, opts);
  } catch (e) {
    // A saved key that is wrong or revoked would otherwise fail identically
    // forever with nothing pointing at the fix.
    if (e instanceof ItadError && e.kind === 'auth') {
      throw new Error(`${e.message}\n\n  Replace it with:\n    keyward config set --itad-key <key>`);
    }
    throw e;
  }

  console.log(`${r.game}: ${r.total} listings, ${r.keyshops.length} on keyshops.`);
  for (const p of r.keyshops) {
    console.log(`  ${p.price.toFixed(2)} ${p.currency}  ${p.shopName}`);
  }
}
