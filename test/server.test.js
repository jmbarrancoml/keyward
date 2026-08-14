import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { serve } from '../dist/ui/server.js';

let handle;
let dir;
let origin;
let token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keyward-ui-'));
  handle = await serve({ dbFile: join(dir, 'ui.db'), port: 0, open: false });
  const url = new URL(handle.url);
  origin = url.origin;
  token = url.searchParams.get('t');
});

after(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path, headers = {}) => fetch(origin + path, { headers });

/**
 * fetch() silently drops a caller-supplied Host header (it is a forbidden
 * header name), so anything asserting on Host has to go out over raw http.
 */
function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: Number(new URL(origin).port), path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('binds to loopback and mints a token per run', () => {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(token.length, 48);
});

test('serves the app when the token is right', async () => {
  const res = await get(`/?t=${token}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>keyward<\/title>/);
});

test('refuses every request without a token', async () => {
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/api/state')).status, 401);
});

test('refuses a wrong token of the same length', async () => {
  // Same length so the comparison cannot be short-circuited by a length check.
  const res = await get('/api/state', { 'x-keyward-token': 'f'.repeat(48) });
  assert.equal(res.status, 401);
});

test('pins the Host header against DNS rebinding', async () => {
  // A hostname that resolves to loopback must not be able to reach the API,
  // because a page on an attacker's domain could otherwise drive it.
  const bad = await rawGet('/api/state', { Host: 'evil.example.com', 'x-keyward-token': token });
  assert.equal(bad.status, 403);

  // The same request with the real Host proves it is the Host check firing and
  // not something else rejecting the request.
  const good = await rawGet('/api/state', {
    Host: `127.0.0.1:${new URL(origin).port}`,
    'x-keyward-token': token,
  });
  assert.equal(good.status, 200);
});

test('refuses cross-origin requests even with a valid token', async () => {
  const res = await get('/api/state', { 'x-keyward-token': token, Origin: 'http://evil.example.com' });
  assert.equal(res.status, 403);
});

test('the login form is let through when the browser sends a null origin', async () => {
  /*
    Chrome sends `Origin: null` for a form navigation from a page served with
    `Referrer-Policy: no-referrer`, which every response here carries. Refusing
    it meant nobody who set a password could ever get past the login page, and
    no test noticed because none of them was a browser submitting a form.
  */
  const login = await fetch(`${origin}/api/login?t=${token}`, {
    method: 'POST',
    headers: { Origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=whatever',
    redirect: 'manual',
  });
  assert.notEqual(login.status, 403, 'the login form was refused as cross-origin');

  // The exception is that one route and no other.
  const elsewhere = await fetch(`${origin}/api/assign?t=${token}`, {
    method: 'POST',
    headers: { Origin: 'null', 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'G', recipient: 'Someone' }),
  });
  assert.equal(elsewhere.status, 403);
});

test('serves state to a properly authenticated request', async () => {
  const res = await get('/api/state', { 'x-keyward-token': token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.games, []);
  // Wording is free to change; the caveat has to keep saying both of these.
  assert.match(body.caveat, /shortlist/i);
  assert.match(body.caveat, /never accuse/i);
});

test('a full round trip through the API produces a report', async () => {
  const post = (path, payload) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'x-keyward-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  assert.equal((await post('/api/game', { name: 'UI Game', appid: 4242 })).status, 200);

  const imported = await (
    await post('/api/import/keys', {
      game: 'UI Game',
      batch: 'press',
      text: 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF\n',
    })
  ).json();
  assert.equal(imported.added, 2);

  const assigned = await (await post('/api/assign', { game: 'UI Game', recipient: 'Someone' })).json();
  assert.match(assigned.key, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){2}$/);

  const report = await (
    await get('/api/report?game=' + encodeURIComponent('UI Game'), { 'x-keyward-token': token })
  ).json();
  assert.equal(report.totals.keys, 2);
  assert.equal(report.totals.assigned, 1);
});

test('reports a bad request instead of crashing', async () => {
  const res = await get('/api/report', { 'x-keyward-token': token });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /game/);
});

test('unknown paths 404 rather than falling through to the app', async () => {
  const res = await get('/api/nope', { 'x-keyward-token': token });
  assert.equal(res.status, 404);
});

test('the live-reload endpoint does not exist outside dev mode', async () => {
  // It holds a connection open and watches the filesystem; neither belongs in
  // a normal run.
  const res = await get('/api/reload', { 'x-keyward-token': token });
  assert.equal(res.status, 404);
});

test('dev mode injects the reload script and honours a pinned token', async () => {
  process.env.KEYWARD_DEV_TOKEN = 'a'.repeat(48);
  const devDir = mkdtempSync(join(tmpdir(), 'keyward-dev-'));
  const dev = await serve({ dbFile: join(devDir, 'dev.db'), port: 0, open: false, dev: true });
  try {
    const devToken = new URL(dev.url).searchParams.get('t');
    assert.equal(devToken, 'a'.repeat(48), 'a restart must not invalidate the open tab');

    const page = await fetch(`${dev.url}`);
    const body = await page.text();
    assert.match(body, /EventSource\('\/api\/reload/);
    assert.doesNotMatch(body, /<!-- dev-reload -->/, 'the placeholder must be replaced');
  } finally {
    await dev.close();
    rmSync(devDir, { recursive: true, force: true });
    delete process.env.KEYWARD_DEV_TOKEN;
  }
});
