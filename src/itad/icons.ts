import type { Db } from '../db.js';

/**
 * Shop logos.
 *
 * The browser must not fetch these: the page is served under a strict CSP and
 * one of its stated properties is that it loads nothing from the network. So
 * the local server fetches each shop's favicon once, stores it as a data URI,
 * and the page renders it from the database like any other value.
 *
 * Best-effort throughout. A shop with no reachable icon simply gets the
 * monogram, and a scan never fails because a logo did not load.
 */

const TIMEOUT_MS = 4000;
/** Comfortably above a real favicon and far below anything worth inlining. */
const MAX_BYTES = 48 * 1024;
/** Re-fetch occasionally so a rebrand is picked up, but rarely. */
const STALE_DAYS = 60;

const TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Standard locations, best first. Nothing here is shop-specific. */
const PATHS = ['/favicon.svg', '/apple-touch-icon.png', '/favicon.png', '/favicon.ico'];

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // A demo or placeholder host is not worth a request.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname.endsWith('.invalid') || u.hostname === 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function fetchIcon(origin: string): Promise<string | null> {
  for (const path of PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(origin + path, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { Accept: 'image/*' },
      });
      if (!res.ok) continue;

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) continue;

      const ext = path.split('.').pop() ?? '';
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() || TYPES[ext] || '';
      if (!type.startsWith('image/')) continue;

      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      // Timeout, DNS failure, refused connection: try the next path.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Fills in any shop logo that is missing or stale. Returns how many were
 * fetched, so a scan can say what it did.
 */
export async function refreshShopIcons(
  db: Db,
  shops: Array<{ shopName: string; url: string | null }>,
): Promise<number> {
  const known = new Map(
    (db.prepare('SELECT shop, fetched_at FROM shop_icons').all() as Array<{
      shop: string;
      fetched_at: string;
    }>).map((r) => [r.shop, r.fetched_at]),
  );
  const cutoff = Date.now() - STALE_DAYS * 86_400_000;

  const save = db.prepare(
    'INSERT OR REPLACE INTO shop_icons (shop, data_uri, fetched_at) VALUES (?, ?, ?)',
  );

  let fetched = 0;
  const seen = new Set<string>();
  for (const shop of shops) {
    if (seen.has(shop.shopName)) continue;
    seen.add(shop.shopName);

    const at = known.get(shop.shopName);
    if (at && Date.parse(at) > cutoff) continue; // still fresh, including known misses

    const origin = originOf(shop.url);
    // Recorded either way: a null data_uri is a remembered miss, so a shop
    // without a reachable icon is not retried on every scan.
    const icon = origin ? await fetchIcon(origin) : null;
    save.run(shop.shopName, icon, new Date().toISOString());
    if (icon) fetched++;
  }
  return fetched;
}

/** Steam's own store page for an appid, and the small capsule art for it. */
export const steamStoreUrl = (appid: number): string =>
  `https://store.steampowered.com/app/${appid}/`;

const CAPSULES = (appid: number) => [
  `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`,
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`,
  `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
];

/**
 * Store art for a game. Fetched by the server and kept as a data URI for the
 * same reason the shop logos are: the page must not reach out to Valve's CDN.
 */
export async function fetchGameImage(appid: number): Promise<string | null> {
  for (const url of CAPSULES(appid)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // Capsule art is comfortably under this; a header.jpg can exceed it.
      if (buf.length === 0 || buf.length > 320 * 1024) continue;
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
      if (!type.startsWith('image/')) continue;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      /* try the next one */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Downloads an arbitrary image the user pasted, so it too becomes local. */
export async function fetchImageUrl(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 320 * 1024) return null;
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
    if (!type.startsWith('image/')) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Makes sure Steam's own mark is cached, for the store link in the header. */
export async function ensureSteamIcon(db: Db): Promise<void> {
  await refreshShopIcons(db, [{ shopName: 'Steam', url: 'https://store.steampowered.com/' }]);
}

export function shopIcons(db: Db): Record<string, string> {
  const rows = db
    .prepare('SELECT shop, data_uri FROM shop_icons WHERE data_uri IS NOT NULL')
    .all() as Array<{ shop: string; data_uri: string }>;
  return Object.fromEntries(rows.map((r) => [r.shop, r.data_uri]));
}
