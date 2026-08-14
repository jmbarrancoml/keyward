import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseActivationDetails, isLoggedOut } from '../dist/steamworks/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('reads an activated key', () => {
  const r = parseActivationDetails(fixture('activated.html'));
  assert.equal(r.status, 'activated');
  assert.equal(r.activatedAt, '15 Jul 2026 @ 4:21pm');
});

test('never guesses an account from an unlabelled cell', () => {
  // Steam does not appear to expose the redeeming account at all. Inferring one
  // from position would report a package name, a store, or whatever else Valve
  // puts in that column as the person who redeemed the key.
  const r = parseActivationDetails(
    '<h2>Activation Details</h2><table><tr>' +
      '<td>Activated</td><td>Lanternfall - Press</td><td>15 Jul 2026</td>' +
      '</tr></table>',
  );
  assert.equal(r.status, 'activated');
  assert.equal(r.account, undefined);
  // but nothing is thrown away
  assert.ok(r.cells.includes('Lanternfall - Press'));
});

test('reads an account only when the page labels one', () => {
  const r = parseActivationDetails(
    '<h2>Activation Details</h2><table><tr>' +
      '<td>Activated</td><td>Account: examplereviewer</td>' +
      '</tr></table>',
  );
  assert.equal(r.account, 'examplereviewer');
});

test('reads an unredeemed key', () => {
  const r = parseActivationDetails(fixture('not-activated.html'));
  assert.equal(r.status, 'not_activated');
  assert.equal(r.account, undefined);
});

test('"Not Activated" is never mistaken for "Activated"', () => {
  // The substring trap: /activated/ matches inside "Not Activated". Getting
  // this wrong would report every unredeemed key as redeemed, which is the
  // exact opposite of what the tool is for.
  const r = parseActivationDetails(
    '<h2>Activation Details</h2><table><tr><td>Not Activated</td></tr></table>',
  );
  assert.equal(r.status, 'not_activated');
});

test('refuses to guess when Steamworks bounces us to the login page', () => {
  const html = fixture('logged-out.html');
  assert.equal(isLoggedOut(html), true);
  assert.throws(() => parseActivationDetails(html), /session cookie/i);
});

test('an unknown page shape yields "unknown", never a wrong answer', () => {
  const r = parseActivationDetails(
    '<h2>Activation Details</h2><table><tr><td>Something Valve changed</td></tr></table>',
  );
  assert.equal(r.status, 'unknown');
  // Cells are retained so the mismatch is debuggable.
  assert.deepEqual(r.cells, ['Something Valve changed']);
});

test('a key Steamworks does not recognise is invalid, not unknown', () => {
  const r = parseActivationDetails('<html><body><p>CD Key not found.</p></body></html>');
  assert.equal(r.status, 'invalid');
});

test('revoked keys are distinguished from unredeemed ones', () => {
  const r = parseActivationDetails(
    '<h2>Activation Details</h2><table><tr><td>Revoked</td><td>someaccount</td></tr></table>',
  );
  assert.equal(r.status, 'revoked');
});

test('HTML entities and nested markup are stripped out of cells', () => {
  const r = parseActivationDetails(
    '<h2>Activation Details</h2><table><tr><td>Activated</td>' +
      '<td><a href="/x">Bob&amp;Co</a></td><td>1 Jan 2026</td></tr></table>',
  );
  assert.ok(r.cells.includes('Bob&Co'));
});
