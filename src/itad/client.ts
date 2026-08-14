import { itadKey } from '../config.js';

const BASE = 'https://api.isthereanydeal.com';

/**
 * Shops whose stock is sourced from the grey market rather than from a direct
 * publisher relationship. Matched on name, not ID, so the list survives ITAD
 * re-indexing and a studio can extend it without a code change.
 */
const KEYSHOP_PATTERNS = [
  'g2a',
  'kinguin',
  'eneba',
  'gamivo',
  'instant gaming',
  'instant-gaming',
  'cdkeys',
  'hrk',
  'k4g',
  'difmark',
  'gamesdeal',
  'scdkey',
  'eneba',
  'goclecd',
  'dlcompare',
  'mmoga',
  'keysforgames',
  'gamekeysnow',
];

export function isKeyshop(shopName: string, extra: string[] = []): boolean {
  const n = shopName.toLowerCase();
  return [...KEYSHOP_PATTERNS, ...extra].some((p) => n.includes(p));
}

interface ItadPriceEntry {
  shop: { id: number; name: string };
  price: { amount: number; currency: string };
  url?: string;
}

interface ItadGamePrices {
  id: string;
  deals?: ItadPriceEntry[];
}

export type ItadFailure = 'auth' | 'rate' | 'network' | 'other';

/** Lets callers tell "your key is wrong" apart from "their server is down". */
export class ItadError extends Error {
  constructor(
    message: string,
    readonly kind: ItadFailure,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ItadError';
  }
}

async function itad(
  path: string,
  init: RequestInit & { query?: Record<string, string>; apiKey?: string } = {},
) {
  const url = new URL(path, BASE);
  url.searchParams.set('key', init.apiKey ?? itadKey());
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const { query: _q, apiKey: _k, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(rest.headers ?? {}) },
    });
  } catch (e) {
    throw new ItadError(`Could not reach IsThereAnyDeal: ${(e as Error).message}`, 'network');
  }

  if (res.status === 401 || res.status === 403) {
    throw new ItadError(
      'IsThereAnyDeal rejected the API key. Check you copied the whole thing from ' +
        'https://isthereanydeal.com/apps/my/, and that you took the API key rather than the ' +
        'OAuth client secret sitting next to it.',
      'auth',
      res.status,
    );
  }
  if (res.status === 429) {
    throw new ItadError('IsThereAnyDeal rate-limited the request. Wait a few minutes.', 'rate', 429);
  }
  if (!res.ok) {
    throw new ItadError(
      `IsThereAnyDeal ${path} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      'other',
      res.status,
    );
  }
  return res.json();
}

/**
 * Confirms a key actually works before it is written anywhere. A key is easy to
 * paste wrong — truncated, or the OAuth secret by mistake — and without this the
 * mistake only shows up later as a failed scan with no obvious cause.
 */
export async function verifyKey(candidate: string): Promise<void> {
  const key = candidate.trim();
  if (key.length < 8) {
    throw new ItadError('That does not look like an API key — it is too short.', 'auth');
  }
  // Any authenticated call proves the key; a lookup for a well-known appid is
  // the cheapest one available.
  await itad('/games/lookup/v1', { query: { appid: '730' }, apiKey: key });
}

/** Resolve a Steam appid to ITAD's internal game id. */
export async function lookupByAppid(appid: number): Promise<string | null> {
  const data = (await itad('/games/lookup/v1', { query: { appid: String(appid) } })) as {
    found?: boolean;
    game?: { id?: string };
  };
  return data.found && data.game?.id ? data.game.id : null;
}

/**
 * Current prices for one game across every shop ITAD tracks.
 * `nondeals=true` matters here: a keyshop selling at its normal price is still
 * a leak signal, and the default response only carries active discounts.
 */
export async function pricesFor(
  itadId: string,
  countryCode: string,
): Promise<Array<{ shopId: number; shopName: string; price: number; currency: string; url: string | null }>> {
  const data = (await itad('/games/prices/v3', {
    method: 'POST',
    query: { country: countryCode, nondeals: 'true', vouchers: 'true' },
    body: JSON.stringify([itadId]),
  })) as ItadGamePrices[];

  const game = data.find((g) => g.id === itadId) ?? data[0];
  return (game?.deals ?? []).map((d) => ({
    shopId: d.shop.id,
    shopName: d.shop.name,
    price: d.price.amount,
    currency: d.price.currency,
    url: d.url ?? null,
  }));
}
