import { getGame, type Db } from '../db.js';

/**
 * The whole ledger, in a form anything else can read.
 *
 * A tool whose argument is that your data stays yours has to hand it back on
 * request, or the sentence means nothing. One row per key, everything keyward
 * knows about it, no thresholds and no inference applied.
 */

export interface ExportRow {
  key: string;
  game: string;
  batch: string;
  batch_created: string;
  recipient: string | null;
  recipient_kind: string | null;
  handle: string | null;
  email: string | null;
  campaign: string | null;
  sent_on: string | null;
  status: string;
  last_checked: string | null;
  redeemed_on: string | null;
  found_on_sale: string | null;
}

export function ledger(db: Db, gameName?: string): ExportRow[] {
  const game = gameName ? getGame(db, gameName) : null;
  return db
    .prepare(
      `SELECT k.key, g.name AS game, b.name AS batch, b.created_at AS batch_created,
              r.name AS recipient, r.kind AS recipient_kind, r.handle, r.email,
              a.campaign, a.assigned_at AS sent_on,
              COALESCE(s.status, 'unchecked') AS status,
              s.checked_at AS last_checked,
              s.activated_at AS redeemed_on,
              (SELECT GROUP_CONCAT(shop, '; ') FROM sightings si WHERE si.key_id = k.id) AS found_on_sale
         FROM keys k
         JOIN batches b ON b.id = k.batch_id
         JOIN games g ON g.id = b.game_id
         LEFT JOIN assignments a ON a.key_id = k.id
         LEFT JOIN recipients r ON r.id = a.recipient_id
         LEFT JOIN (SELECT key_id, status, checked_at, activated_at,
                           ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY checked_at DESC) AS rn
                      FROM activations) s ON s.key_id = k.id AND s.rn = 1
        WHERE (? IS NULL OR g.id = ?)
        ORDER BY g.name, b.name, a.assigned_at IS NULL, a.assigned_at, k.key`,
    )
    .all(game?.id ?? null, game?.id ?? null) as unknown as ExportRow[];
}

const COLUMNS: Array<keyof ExportRow> = [
  'key', 'game', 'batch', 'batch_created', 'recipient', 'recipient_kind', 'handle',
  'email', 'campaign', 'sent_on', 'status', 'last_checked', 'redeemed_on', 'found_on_sale',
];

/**
 * RFC 4180: quote everything, double the quotes inside. Spreadsheets vary.
 *
 * And one thing that is not in RFC 4180. Excel, LibreOffice and Sheets all treat
 * a cell beginning with = + - @ or a control character as a formula, quoted or
 * not, so a contact named `=HYPERLINK("http://…")` becomes a live link the
 * moment the export is opened. Contact names come from a person typing, and shop
 * names come from an API, so neither is ours to trust. A leading apostrophe is
 * the convention every spreadsheet understands for "this is text".
 */
function cell(value: unknown): string {
  const text = String(value ?? '');
  const quoted = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${quoted.replace(/"/g, '""')}"`;
}

export function toCsv(rows: ExportRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => cell(row[c])).join(','));
  return lines.join('\n') + '\n';
}

export function exportLedger(db: Db, opts: { game?: string; json?: boolean }): void {
  const rows = ledger(db, opts.game);
  // Straight to stdout so it pipes into a file, a spreadsheet or another tool.
  process.stdout.write(opts.json ? JSON.stringify(rows, null, 2) + '\n' : toCsv(rows));
}
