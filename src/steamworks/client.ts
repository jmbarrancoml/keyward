import { parseActivationDetails } from './parse.js';
import { getSteamCookie } from '../secrets.js';
import type { ActivationDetails } from '../types.js';

const ENDPOINT = 'https://partner.steamgames.com/querycdkey/cdkey';

/**
 * Valve publishes no key API, so this drives the same page a human would open.
 * That imposes two rules we follow everywhere below: one request at a time, and
 * a deliberate delay between them. Hammering partner.steamgames.com risks the
 * studio's session, which is a far worse outcome than a slow scan.
 */
export interface QueryOptions {
  signal?: AbortSignal;
}

export async function queryKey(key: string, opts: QueryOptions = {}): Promise<ActivationDetails> {
  const url = `${ENDPOINT}?cdkey=${encodeURIComponent(key)}&method=Query`;
  const res = await fetch(url, {
    headers: {
      Cookie: getSteamCookie(),
      'User-Agent': 'keyward/0.1 (+https://github.com/keyward/keyward)',
      Accept: 'text/html',
    },
    redirect: 'follow',
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (res.status === 429) {
    throw new Error('Steamworks rate-limited the request (429). Raise --delay and resume later.');
  }
  if (!res.ok) {
    throw new Error(`Steamworks returned HTTP ${res.status} for the key query.`);
  }
  return parseActivationDetails(await res.text());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
