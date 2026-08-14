/** Minimal RFC4180 reader — enough for Steamworks exports and hand-made lists. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',' || c === ';' || c === '\t') {
      row.push(field.trim());
      field = '';
    } else if (c === '\n') {
      row.push(field.trim());
      if (row.some((f) => f.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field.trim());
  if (row.some((f) => f.length > 0)) rows.push(row);
  return rows;
}

/** Steam keys are groups of five alphanumerics: AAAAA-BBBBB-CCCCC. */
export const STEAM_KEY_RE = /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){2,4}$/i;

/**
 * The same shape, found anywhere in a blob of text. The boundaries matter: they
 * stop a longer run of characters from yielding a key out of its middle, so a
 * commit hash or a six-character group is left alone.
 */
const KEY_ANYWHERE = /(?<![A-Z0-9-])[A-Z0-9]{5}(?:-[A-Z0-9]{5}){2,4}(?![A-Z0-9-])/gi;

/**
 * Pull keys out of whatever someone pastes.
 *
 * This used to parse the text as a CSV and take cells that were exactly a key,
 * which handled the file Steamworks gives you and quietly dropped everything
 * else: keys separated by spaces, keys in a bulleted list, keys sitting in the
 * middle of a forwarded email. Nothing told you they had gone. Scanning the raw
 * text instead makes "paste whatever you have" true rather than aspirational,
 * and costs nothing, because a Steam key is a distinctive enough shape to find
 * on its own.
 */
export function extractKeys(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(KEY_ANYWHERE)) seen.add(match[0].toUpperCase());
  return [...seen];
}

/**
 * Tokens that are nearly a key: right punctuation, wrong group lengths. Used
 * only to explain an import that found nothing, which is almost always a paste
 * that got truncated or wrapped. Reporting these when real keys were also found
 * would be noise, so callers only ask when the list came back empty.
 */
const NEAR_MISS = /(?<![A-Z0-9-])[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){2,4}(?![A-Z0-9-])/gi;

export function nearMisses(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(NEAR_MISS)) {
    const token = match[0].toUpperCase();
    if (!STEAM_KEY_RE.test(token)) out.add(token);
  }
  return [...out].slice(0, 5);
}
