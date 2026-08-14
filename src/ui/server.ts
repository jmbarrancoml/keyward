import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { openDb, getGame, saveDb, type Db } from '../db.js';
import { country, loadConfig, saveConfig } from '../config.js';
import { buildReport, CAVEAT } from '../commands/report.js';
import {
  assignKey, importKeysFromText, importRecipientsFromText, createGame, assertNewGame,
} from '../commands/manage.js';
import { handOut, toHandoutCsv } from '../commands/handout.js';
import { unusedKeys, remindList } from '../commands/hygiene.js';
import { runScan } from '../commands/scan.js';
import { verifyKey, ItadError } from '../itad/client.js';
import { runCheck } from '../commands/check.js';
import { isDemo } from '../commands/demo.js';
import { traceKey, recordSighting } from '../commands/trace.js';
import { listKeys, listContacts } from '../commands/browse.js';
import { createBatch, renameBatch, deleteBatch } from '../commands/batches.js';
import { looksLikeZip, zipToText } from '../unzip.js';
import { ledger, toCsv } from '../commands/export.js';
import { revokeKey, renameContact, deleteContact } from '../commands/edit.js';
import { setSteamCookie, getSteamCookie } from '../secrets.js';
import { hasPassword, checkPassword } from '../password.js';
import { markSeen } from '../alerts.js';
import { thresholds } from '../config.js';
import { fetchGameImage, fetchImageUrl, ensureSteamIcon, steamStoreUrl } from '../itad/icons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_HTML = join(HERE, 'app.html');
/** In a checkout, serve the source file so edits show up without a rebuild. */
const SRC_HTML = resolve(HERE, '..', '..', 'src', 'ui', 'app.html');
const BOOT = Date.now();

const RELOAD_SCRIPT = `<script>
  // Dev only. Reloads on an app.html edit, and also after the server restarts
  // (a tsc rebuild), which EventSource reconnects to on its own.
  (() => {
    let boot = null;
    const src = new EventSource('/api/reload?t=' + (new URLSearchParams(location.search).get('t') || ''));
    src.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.changed || (boot !== null && m.boot !== boot)) return location.reload();
      if (m.boot) boot = m.boot;
    };
  })();
</script>`;

/**
 * A local UI for a tool whose whole premise is that the data never leaves the
 * machine. Three rules follow from that and are enforced below:
 *
 *   1. Bind to 127.0.0.1 only, never 0.0.0.0.
 *   2. Require a per-run random token on every request, so another page or
 *      process on this machine cannot drive the studio's key database.
 *   3. Pin the Host header, so a DNS-rebinding attack cannot reach us with a
 *      hostname that resolves to loopback.
 */

/*
  Sessions live in memory, so stopping the server ends every one of them. That
  suits a tool you start when you need it, and it means a stolen cookie is worth
  nothing once you quit.
*/
/** How long a new game may spend looking for its artwork before it is added without. */
const ART_BUDGET_MS = 5000;

const SESSIONS = new Map<string, number>();
const SESSION_HOURS = 12;
const COOKIE = 'keyward_session';

/*
  scrypt already makes each guess cost about a tenth of a second, which is a
  throttle of sorts. This makes it a wall: after ten wrong answers the door
  stays shut for a while, whatever the attacker's hardware. Counted in memory,
  so it resets when you restart the server you control.
*/
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 5 * 60_000;
let failures = 0;
let lockedUntil = 0;

function newSession(): string {
  const id = randomBytes(24).toString('hex');
  SESSIONS.set(id, Date.now() + SESSION_HOURS * 3600_000);
  return id;
}

function validSession(req: IncomingMessage): boolean {
  const raw = req.headers.cookie ?? '';
  const found = raw.split(';').map((c) => c.trim().split('='));
  const id = found.find(([k]) => k === COOKIE)?.[1];
  if (!id) return false;
  const expires = SESSIONS.get(id);
  if (!expires) return false;
  if (expires < Date.now()) {
    SESSIONS.delete(id);
    return false;
  }
  return true;
}

const LOGIN_PAGE = (failed: boolean, token: string, message = 'That password did not match.'): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>keyward</title><style>
  :root { --page:#f1f1f3; --surface:#fff; --sunken:#e8e8eb; --ink:#101013; --ink-2:#56565f; --rule:#e3e3e6; }
  @media (prefers-color-scheme: dark) {
    :root { --page:#0b0b0d; --surface:#151517; --sunken:#1e1e21; --ink:#f0f0f2; --ink-2:#9a9aa4; --rule:#292a2e; }
  }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--page);
    color:var(--ink); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  form { background:var(--surface); padding:30px; border-radius:14px; width:min(380px, calc(100vw - 32px));
    box-shadow:0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .07); }
  h1 { margin:0 0 6px; font-size:19px; letter-spacing:-.01em; }
  p { margin:0 0 20px; color:var(--ink-2); font-size:13px; line-height:1.6; }
  input { width:100%; box-sizing:border-box; font:15px/1.5 inherit; color:var(--ink);
    background:var(--page); border:1px solid var(--rule); border-radius:9px; padding:11px 12px; }
  button { width:100%; margin-top:12px; font:500 14px/1 inherit; background:var(--ink); color:var(--page);
    border:none; border-radius:9px; padding:12px; min-height:40px; cursor:pointer; }
  .err { margin:16px 0 0; padding:11px 13px; font-size:13px; background:var(--sunken);
    border-left:3px solid var(--ink); border-radius:0 9px 9px 0; color:var(--ink-2); }
</style></head><body>
<form method="post" action="/api/login?t=${encodeURIComponent(token)}">
  <h1>keyward</h1>
  <p>This gate covers the web interface. The database is a file on this machine
     and the command line reads it without asking, so run <code>keyward encrypt</code>
     as well if the file itself is the worry.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" />
  <button type="submit">Unlock</button>
  ${failed ? `<p class="err">${message}</p>` : ''}
</form></body></html>`;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    // The UI is entirely self-contained; nothing should ever load or connect out.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // frame-ancestors covers modern browsers; this covers the rest.
    'X-Frame-Options': 'DENY',
  });
  res.end(payload);
}

async function readForm(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new Error('Request body too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Key batches are the biggest thing anyone pastes in; 8MB is thousands of
    // keys and still small enough that a runaway upload cannot exhaust memory.
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`Missing "${field}".`);
  return v.trim();
}

interface Ctx {
  db: Db;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  dev: boolean;
}

async function route(ctx: Ctx): Promise<void> {
  const { db, url, req, res, dev } = ctx;
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/reload') {
    if (!dev) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ boot: BOOT })}\n\n`);
    const file = existsSync(SRC_HTML) ? SRC_HTML : APP_HTML;
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(file, () => {
      // macOS emits several events per save; collapse them.
      clearTimeout(timer);
      timer = setTimeout(() => res.write(`data: ${JSON.stringify({ changed: true })}\n\n`), 80);
    });
    req.on('close', () => {
      clearTimeout(timer);
      watcher.close();
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    const cfg = loadConfig();
    const games = db
      .prepare(
        `SELECT g.name, g.steam_appid AS appid, g.image, g.store_url AS storeUrl,
                (SELECT COUNT(*) FROM keys k JOIN batches b ON b.id = k.batch_id WHERE b.game_id = g.id) AS keys,
                (SELECT COUNT(*) FROM assignments a JOIN keys k ON k.id = a.key_id
                   JOIN batches b ON b.id = k.batch_id WHERE b.game_id = g.id) AS assigned
           FROM games g ORDER BY g.name`,
      )
      .all();
    const recipients = db.prepare('SELECT name, kind, handle FROM recipients ORDER BY name').all();
    return send(res, 200, {
      games,
      recipients,
      caveat: CAVEAT,
      demo: isDemo(db),
      config: {
        itad: Boolean(cfg.itadKey ?? process.env['KEYWARD_ITAD_KEY']),
        steam: (() => {
          try {
            return Boolean(getSteamCookie());
          } catch {
            return false;
          }
        })(),
        country: country(),
      },
    });
  }

  if (req.method === 'GET' && path === '/api/trace') {
    const result = traceKey(db, str(url.searchParams.get('key'), 'key'));
    const seenOn = url.searchParams.get('seenOn')?.trim();
    const country = url.searchParams.get('country')?.trim();
    // Recording it is what turns a one-off lookup into evidence the rules can
    // use later. Only meaningful for a key we actually own.
    if (seenOn && result.verdict !== 'unknown') {
      recordSighting(db, result.key, seenOn, undefined, undefined, country);
    }
    return send(res, 200, result);
  }

  if (req.method === 'GET' && path === '/api/keys') {
    return send(
      res,
      200,
      listKeys(db, {
        game: str(url.searchParams.get('game'), 'game'),
        filter: (url.searchParams.get('filter') ?? 'all') as never,
        q: url.searchParams.get('q') ?? '',
        sort: (url.searchParams.get('sort') ?? 'sent') as never,
        desc: url.searchParams.get('dir') !== 'asc',
      }),
    );
  }

  if (req.method === 'GET' && path === '/api/contacts') {
    return send(res, 200, listContacts(db, str(url.searchParams.get('game'), 'game')));
  }

  if (req.method === 'GET' && path === '/api/report') {
    const game = str(url.searchParams.get('game'), 'game');
    const dormantDays = Number(url.searchParams.get('dormantDays') ?? 14);
    return send(res, 200, buildReport(db, { game, dormantDays }));
  }

  if (req.method === 'POST' && path === '/api/game') {
    const body = await readJson(req);
    const name = str(body['name'], 'name');
    const appid = body['appid'] ? Number(body['appid']) : null;
    if (appid !== null && !Number.isInteger(appid)) throw new Error('The appid must be a number.');

    // Refuse a duplicate before downloading anything: the art attempt costs
    // seconds on a bad connection, and spending them to then reject the name
    // looks like the dialog has hung.
    assertNewGame(db, name);

    // Art is downloaded here rather than linked, so the page keeps loading
    // nothing from the network. Best-effort — a game without art is fine, and
    // the whole attempt is bounded so a dead connection cannot hold the dialog
    // open while three CDN addresses each time out in turn.
    let image: string | null = null;
    const pasted = typeof body['imageUrl'] === 'string' ? body['imageUrl'].trim() : '';
    try {
      image = await Promise.race([
        pasted ? fetchImageUrl(pasted) : appid !== null ? fetchGameImage(appid) : Promise.resolve(null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ART_BUDGET_MS)),
      ]);
    } catch {
      /* no art */
    }

    createGame(db, {
      name,
      appid,
      image,
      storeUrl: appid !== null ? steamStoreUrl(appid) : null,
    });
    if (appid !== null) {
      try {
        await ensureSteamIcon(db);
      } catch {
        /* the button falls back to a plain label */
      }
    }
    return send(res, 200, { ok: true, art: Boolean(image) });
  }

  if (req.method === 'GET' && path === '/api/export') {
    const game = url.searchParams.get('game') ?? undefined;
    const csv = toCsv(ledger(db, game));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="keyward-${(game ?? 'all').replace(/\W+/g, '-').toLowerCase()}.csv"`,
      'Cache-Control': 'no-store',
    });
    return void res.end(csv);
  }

  if (req.method === 'POST' && path === '/api/key/revoke') {
    const body = await readJson(req);
    return send(res, 200, revokeKey(db, str(body['key'], 'key'), String(body['note'] ?? '')));
  }

  if (req.method === 'POST' && path === '/api/contact/rename') {
    const body = await readJson(req);
    return send(res, 200, renameContact(db, str(body['from'], 'from'), str(body['to'], 'to')));
  }

  if (req.method === 'POST' && path === '/api/contact/delete') {
    const body = await readJson(req);
    deleteContact(db, str(body['name'], 'name'));
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/steam-cookie') {
    const body = await readJson(req);
    const cookie = str(body['cookie'], 'cookie');
    if (!cookie.includes('steamLoginSecure')) {
      throw new Error('That does not look like a Steamworks cookie. It has to contain steamLoginSecure.');
    }
    setSteamCookie(cookie);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/seen') {
    // Called when the overview is opened, so "new since last time" means what
    // it says rather than resetting on any old page load.
    const body = await readJson(req);
    const game = getGame(db, str(body['game'], 'game'));
    const { findings } = buildReport(db, { game: game.name, dormantDays: thresholds().dormantDays });
    markSeen(db, game.id, findings);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/batch') {
    const body = await readJson(req);
    createBatch(
      db,
      str(body['game'], 'game'),
      str(body['name'], 'name'),
      String(body['note'] ?? ''),
      String(body['region'] ?? ''),
    );
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/batch/rename') {
    const body = await readJson(req);
    const result = renameBatch(
      db,
      str(body['game'], 'game'),
      str(body['from'], 'from'),
      str(body['to'], 'to'),
    );
    return send(res, 200, result);
  }

  if (req.method === 'POST' && path === '/api/batch/delete') {
    const body = await readJson(req);
    deleteBatch(db, str(body['game'], 'game'), str(body['name'], 'name'));
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/assign') {
    const body = await readJson(req);
    const result = assignKey(db, {
      game: str(body['game'], 'game'),
      recipient: str(body['recipient'], 'recipient'),
      ...(body['campaign'] ? { campaign: String(body['campaign']) } : {}),
      // Which batch matters: taking a distributor's key for a journalist is
      // what quietly destroys the channel attribution everything else rests on.
      ...(body['batch'] ? { batch: String(body['batch']) } : {}),
    });
    return send(res, 200, result);
  }

  if (req.method === 'POST' && path === '/api/import/keys') {
    const body = await readJson(req);
    // A file arrives as base64 so the server can unzip it: the download from
    // Steamworks is an archive, and asking someone to unzip it first is a step
    // that exists only because the software could not be bothered.
    let text: string;
    if (typeof body['fileB64'] === 'string' && body['fileB64']) {
      const buf = Buffer.from(body['fileB64'], 'base64');
      text = looksLikeZip(buf) ? zipToText(buf) : buf.toString('utf8');
    } else {
      text = str(body['text'], 'text');
    }
    return send(res, 200, importKeysFromText(db, {
      game: str(body['game'], 'game'),
      batch: str(body['batch'], 'batch'),
      text,
    }));
  }

  if (req.method === 'POST' && path === '/api/import/recipients') {
    const body = await readJson(req);
    return send(res, 200, { added: importRecipientsFromText(db, str(body['text'], 'text')) });
  }

  if (req.method === 'POST' && path === '/api/config') {
    const body = await readJson(req);
    const patch: Parameters<typeof saveConfig>[0] = {};
    if (body['itadKey']) {
      const candidate = str(body['itadKey'], 'itadKey');
      // Verified before it is written, so a mistyped key never becomes a
      // mystery failure three screens later.
      await verifyKey(candidate);
      patch.itadKey = candidate;
    }
    if (body['country']) patch.country = str(body['country'], 'country').toUpperCase().slice(0, 2);
    if (Object.keys(patch).length === 0) throw new Error('Nothing to set.');
    saveConfig(patch);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/scan') {
    const body = await readJson(req);
    try {
      return send(res, 200, await runScan(db, { game: str(body['game'], 'game'), country: country() }));
    } catch (e) {
      // A stored key that has been revoked or was always wrong should send the
      // user back to the setup flow, not just print an error.
      if (e instanceof ItadError && e.kind === 'auth') {
        return send(res, 401, { error: e.message, needsKey: true });
      }
      throw e;
    }
  }

  // Checking hundreds of keys takes minutes by design, so it streams rather
  // than leaving the UI on a spinner with nothing to show.
  if (req.method === 'GET' && path === '/api/check') {
    const game = str(url.searchParams.get('game'), 'game');
    const delayMs = Math.max(1000, Number(url.searchParams.get('delay') ?? 1500));
    const since = Number(url.searchParams.get('since') ?? 0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      await runCheck(
        db,
        { game, delayMs, ...(since > 0 ? { sinceHours: since } : {}) },
        (e) => res.write(`data: ${JSON.stringify(e)}\n\n`),
        controller.signal,
      );
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'stopped', key: '', message: (e as Error).message })}\n\n`);
    }
    return void res.end();
  }

  if (req.method === 'GET' && path === '/api/unused') {
    return send(res, 200, { batches: unusedKeys(db, url.searchParams.get('game') ?? undefined) });
  }

  if (req.method === 'GET' && path === '/api/remind') {
    const days = Number(url.searchParams.get('days') ?? 14);
    return send(res, 200, {
      people: remindList(db, str(url.searchParams.get('game'), 'game'), Number.isFinite(days) ? days : 14),
    });
  }

  if (req.method === 'POST' && path === '/api/handout') {
    const body = await readJson(req);
    const out = handOut(db, {
      game: str(body['game'], 'game'),
      text: str(body['text'], 'text'),
      ...(body['batch'] ? { batch: String(body['batch']) } : {}),
      ...(body['campaign'] ? { campaign: String(body['campaign']) } : {}),
    });
    // The CSV comes back with it so the page can offer the download without a
    // second request, which would need the keys to survive somewhere in between.
    return send(res, 200, { ...out, csv: toHandoutCsv(out.rows) });
  }

  send(res, 404, { error: 'Not found' });
}

export interface UiOptions {
  dbFile: string;
  port: number;
  open: boolean;
  /** Serve app.html from source, re-read per request, and push live reloads. */
  dev?: boolean;
}

export interface UiHandle {
  url: string;
  close: () => Promise<void>;
}

export function serve(opts: UiOptions): Promise<UiHandle> {
  const dev = Boolean(opts.dev);
  // In dev the process restarts on every rebuild, so the token is pinned by the
  // runner. Otherwise it is fresh per run and dies with the server.
  const token = (dev ? process.env['KEYWARD_DEV_TOKEN'] : undefined) || randomBytes(24).toString('hex');
  const db = openDb(opts.dbFile);

  const loadHtml = (): string => {
    if (!dev) return readFileSync(APP_HTML, 'utf8');
    const file = existsSync(SRC_HTML) ? SRC_HTML : APP_HTML;
    return readFileSync(file, 'utf8').replace('<!-- dev-reload -->', RELOAD_SCRIPT);
  };
  const cached = dev ? null : loadHtml();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? '';
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : opts.port;
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
          return send(res, 403, { error: 'Bad Host header.' });
        }

        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        const supplied = (req.headers['x-keyward-token'] as string | undefined) ?? url.searchParams.get('t') ?? '';
        if (!safeEqual(supplied, token)) {
          return send(res, 401, { error: 'Bad or missing token.' });
        }

        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
          /*
            One exception, and it is not a loosening of anything.

            Chrome sends `Origin: null` when a form navigation comes from a
            document served with `Referrer-Policy: no-referrer`, which every
            response here carries. The login page is the only plain form in the
            application, so it was the only request that could arrive that way,
            and refusing it locked every person who set a password out of their
            own browser with "Cross-origin request refused".

            A login POST from a foreign page still needs this run's token, still
            needs the password, and still lands a cookie on an origin that page
            cannot read. Everything else keeps the strict check.
          */
          const loginForm = origin === 'null' && req.method === 'POST' && url.pathname === '/api/login';
          if (!loginForm) return send(res, 403, { error: 'Cross-origin request refused.' });
        }

        // The password, when one is set, sits on top of the token: the token
        // proves the request came from this run, the password proves it came
        // from you.
        const locked = hasPassword();

        if (url.pathname === '/api/login') {
          if (Date.now() < lockedUntil) {
            const minutes = Math.ceil((lockedUntil - Date.now()) / 60_000);
            return send(
              res,
              429,
              LOGIN_PAGE(true, token, `Too many wrong answers. Try again in ${minutes} minutes.`),
              'text/html',
            );
          }
          const body = req.method === 'POST' ? await readForm(req) : '';
          const supplied = new URLSearchParams(body).get('password') ?? '';
          if (!checkPassword(supplied)) {
            if (++failures >= MAX_ATTEMPTS) {
              lockedUntil = Date.now() + LOCKOUT_MS;
              failures = 0;
            }
            return send(res, 401, LOGIN_PAGE(true, token), 'text/html');
          }
          failures = 0;
          res.writeHead(302, {
            'Set-Cookie': `${COOKIE}=${newSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
            Location: `/?t=${encodeURIComponent(token)}`,
          });
          return void res.end();
        }

        if (locked && !validSession(req)) {
          if (url.pathname === '/' || url.pathname === '/index.html') {
            return send(res, 200, LOGIN_PAGE(false, token), 'text/html');
          }
          return send(res, 401, { error: 'Locked. Reload the page and sign in.', locked: true });
        }

        if (url.pathname === '/' || url.pathname === '/index.html') {
          return send(res, 200, cached ?? loadHtml(), 'text/html');
        }
        if (url.pathname.startsWith('/api/')) {
          await route({ db, url, req, res, dev });
          // Encrypted databases live in memory, so anything that changed one
          // has to be written back now rather than at shutdown.
          if (req.method === 'POST') saveDb(db);
          return;
        }
        send(res, 404, { error: 'Not found' });
      } catch (e) {
        if (!res.headersSent) send(res, 400, { error: (e as Error).message });
        else res.end();
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(opts.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        url: `http://127.0.0.1:${port}/?t=${token}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              saveDb(db);
              db.close();
              done();
            });
          }),
      });
    });
  });
}
