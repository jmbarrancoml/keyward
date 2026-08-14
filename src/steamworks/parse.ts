import type { ActivationDetails, ActivationStatus } from '../types.js';

/**
 * Steamworks has no documented key API. `querycdkey` returns an HTML page whose
 * "Activation Details" table is the only place activation state is exposed.
 * The shape below is what the page has emitted historically; if Valve changes
 * it, `cells` still carries everything we saw so the failure is diagnosable
 * instead of silent.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when Steamworks bounced us to the login wall instead of answering. */
export function isLoggedOut(html: string): boolean {
  return (
    /<title>[^<]*Steam (?:Community )?:? ?Sign ?In/i.test(html) ||
    /id=["']steamAccountName["']/i.test(html) ||
    /https:\/\/(?:store\.)?steampowered\.com\/login/i.test(html)
  );
}

function classify(cells: string[]): ActivationStatus {
  const joined = cells.join(' | ').toLowerCase();
  if (/\brevoked\b|\bbanned\b/.test(joined)) return 'revoked';
  if (/\bactivated\b/.test(joined) && !/\bnot activated\b|\bnever activated\b/.test(joined)) {
    return 'activated';
  }
  if (/\bnot activated\b|\bnever activated\b|\bunused\b/.test(joined)) return 'not_activated';
  if (/\bnot found\b|\binvalid\b|\bno such\b|\bdoes not exist\b/.test(joined)) return 'invalid';
  return 'unknown';
}

/**
 * Steam does not appear to tell partners which account redeemed a key: the
 * Activation Details table carries a status and a date, and public batch-query
 * scripts have never read anything else out of it. Valve's own documentation is
 * silent, and the community answer is a flat no on privacy grounds.
 *
 * So this only reads an account when a cell is explicitly labelled as one. It
 * deliberately does not infer one from position — guessing that "the cell that
 * is not the status and not the date must be the account" would happily report
 * a package name or a store as the person who redeemed the key, and keyward
 * showing a wrong name in that column is the one failure mode that actually
 * hurts somebody.
 *
 * Every cell is kept in `cells` regardless, so if Valve does expose more, it is
 * visible in the stored payload rather than lost.
 */
function findAccount(cells: string[]): string | undefined {
  for (const cell of cells) {
    const labelled = /^(?:steam )?account(?: name)?\s*:\s*(.+)$/i.exec(cell);
    if (labelled?.[1]) return labelled[1].trim();
  }
  return undefined;
}

function looksLikeDate(s: string): boolean {
  return /\d{4}/.test(s) && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d{1,2})/i.test(s);
}

function findDate(cells: string[]): string | undefined {
  return cells.find(looksLikeDate);
}

export function parseActivationDetails(html: string): ActivationDetails {
  if (isLoggedOut(html)) {
    throw new Error(
      'Steamworks returned a login page. The session cookie is missing or expired — refresh it with `keyward auth set`.',
    );
  }

  const marker = /<h2[^>]*>\s*Activation Details\s*<\/h2>/i.exec(html);
  if (!marker) {
    // No details block at all: Steamworks renders a bare error for keys it
    // does not recognise as belonging to this partner.
    const text = stripTags(html);
    if (/not found|invalid|no such|does not exist/i.test(text)) {
      return { status: 'invalid', cells: [] };
    }
    return { status: 'unknown', cells: [] };
  }

  const after = html.slice(marker.index + marker[0].length);
  const table = after.split(/<\/table>/i)[0] ?? '';
  const cells = [...table.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => stripTags(m[1] ?? ''))
    .filter((c) => c.length > 0);

  const status = classify(cells);
  const details: ActivationDetails = { status, cells };
  if (status === 'activated') {
    const account = findAccount(cells);
    const activatedAt = findDate(cells);
    if (account) details.account = account;
    if (activatedAt) details.activatedAt = activatedAt;
  }
  return details;
}
