import { execFile } from 'node:child_process';
import { getGame, type Db } from '../db.js';
import { buildReport } from './report.js';
import { runScan } from './scan.js';
import { runCheck } from './check.js';
import { unseenFindings, markSeen } from '../alerts.js';
import { country, loadConfig, thresholds } from '../config.js';
import { SEVERITY_ORDER, type Finding } from '../rules.js';

/**
 * The command you put in cron or launchd.
 *
 * keyward otherwise only notices a problem when you open it, which can be
 * weeks. This refreshes what it can, works out what is new since the last run,
 * and says so. It exits 1 when something is new, so cron mails you the output
 * without any further arrangement.
 *
 * There is deliberately no daemon. A background process you did not start is
 * how a local tool turns into something you have to watch in return.
 */

export interface WatchOptions {
  game?: string;
  /** Keys to query against Steamworks per run. Checking hundreds takes minutes. */
  limit: number;
  notify: boolean;
  webhook?: string;
  quiet: boolean;
}

export interface WatchResult {
  game: string;
  fresh: Finding[];
  checked: number;
  scanned: boolean;
}

function say(quiet: boolean, line = ''): void {
  if (!quiet) console.log(line);
}

/**
 * A desktop notification, through whatever is already installed. Nothing here
 * is worth a dependency, and a notification that fails is not worth a word: the
 * findings are on stdout either way, which is what cron mails you.
 */
function notifyDesktop(title: string, body: string): void {
  if (process.platform === 'darwin') {
    const escape = (s: string) => s.replace(/["\\]/g, '\\$&');
    execFile(
      'osascript',
      ['-e', `display notification "${escape(body)}" with title "${escape(title)}"`],
      () => {},
    );
    return;
  }

  if (process.platform === 'win32') {
    // A balloon from the tray, which Windows PowerShell can raise on its own.
    // The modern toast API wants a registered AppUserModelID, which a CLI
    // installed by npm does not have.
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      $n = New-Object System.Windows.Forms.NotifyIcon
      $n.Icon = [System.Drawing.SystemIcons]::Information
      $n.BalloonTipTitle = [Console]::In.ReadLine()
      $n.BalloonTipText = [Console]::In.ReadLine()
      $n.Visible = $true
      $n.ShowBalloonTip(10000)
      Start-Sleep -Seconds 10
      $n.Dispose()
    `;
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      () => {},
    );
    // One line each, so neither can be mistaken for the other.
    child.stdin?.end(`${title.replace(/\r?\n/g, ' ')}\n${body.replace(/\r?\n/g, ' ')}\n`);
    return;
  }

  execFile('notify-send', ['--app-name=keyward', title, body], () => {});
}

/**
 * Sends the findings somewhere off this machine. Off by default and never
 * implicit: it is the one thing keyward does that breaks its own rule about
 * data staying local, so the caller has to ask for it by URL.
 */
async function postWebhook(url: string, game: string, fresh: Finding[]): Promise<void> {
  const lines = fresh.map((f) => `• *${f.severity}* — ${f.summary}`).join('\n');
  const body = {
    // Slack and Discord both render a plain "text" field, so one shape covers
    // the two places a studio actually reads things.
    text: `*${game}* — ${fresh.length} new ${fresh.length === 1 ? 'finding' : 'findings'}\n${lines}`,
    game,
    findings: fresh.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      subject: f.subject,
      summary: f.summary,
      count: f.count,
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`the webhook answered HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function watch(db: Db, opts: WatchOptions): Promise<WatchResult[]> {
  const games = opts.game
    ? [getGame(db, opts.game)]
    : (db.prepare('SELECT * FROM games ORDER BY name').all() as unknown as Array<{
        id: number;
        name: string;
      }>);

  const webhook = opts.webhook ?? loadConfig().webhookUrl;
  const results: WatchResult[] = [];

  for (const game of games) {
    let checked = 0;
    let scanned = false;

    if (opts.limit > 0) {
      try {
        await runCheck(db, { game: game.name, limit: opts.limit, delayMs: 1500 }, (e) => {
          if (e.type === 'done') checked = e.done;
        });
      } catch (e) {
        say(opts.quiet, `  could not reach Steamworks: ${(e as Error).message}`);
      }
    }

    try {
      await runScan(db, { game: game.name, country: country() });
      scanned = true;
    } catch (e) {
      say(opts.quiet, `  could not check prices: ${(e as Error).message}`);
    }

    const t = thresholds();
    const { findings } = buildReport(db, { game: game.name, dormantDays: t.dormantDays });
    const fresh = unseenFindings(db, game.id, findings).sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    markSeen(db, game.id, findings);

    results.push({ game: game.name, fresh, checked, scanned });

    if (fresh.length === 0) {
      say(opts.quiet, `${game.name}: nothing new.`);
      continue;
    }

    say(opts.quiet, `${game.name}: ${fresh.length} new.`);
    for (const f of fresh) say(opts.quiet, `  [${f.severity}] ${f.summary}`);
    say(opts.quiet);

    if (opts.notify) {
      notifyDesktop(
        `keyward — ${game.name}`,
        fresh[0]?.summary ?? `${fresh.length} new findings`,
      );
    }
    if (webhook) {
      try {
        await postWebhook(webhook, game.name, fresh);
      } catch (e) {
        say(opts.quiet, `  could not post to the webhook: ${(e as Error).message}`);
      }
    }
  }

  return results;
}
