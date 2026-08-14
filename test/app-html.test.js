import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The UI is a single hand-written HTML file with no bundler and no type
 * checking, so nothing else in the build would catch a syntax error in it —
 * the page would just render blank. These checks are the substitute.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'dist', 'ui', 'app.html'), 'utf8');

function inlineScript() {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'app.html must contain an inline script');
  return m[1];
}

test('the build copies app.html next to the compiled server', () => {
  assert.match(html, /<title>keyward<\/title>/);
});

test('the inline script parses', () => {
  // Function() compiles without executing, which is exactly the check we want.
  assert.doesNotThrow(() => new Function(inlineScript()));
});

test('every data-act in the markup has a handler', () => {
  const script = inlineScript();
  const acts = new Set([...html.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]));
  // These are wired through the delegated click handler or the DIALOGS map.
  for (const act of acts) {
    assert.ok(
      script.includes(`'${act}'`) || script.includes(`${act}:`) || script.includes(`'${act}':`),
      `data-act="${act}" appears in the markup with no handler in the script`,
    );
  }
});

test('every icon referenced by the script is defined in the sprite', () => {
  const defined = new Set([...html.matchAll(/<g id="i-([a-z]+)">/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/icon\('([a-z]+)'/g)].map((m) => m[1]));
  for (const name of used) assert.ok(defined.has(name), `icon("${name}") has no sprite definition`);
});

test('the UI ships no emoji and loads nothing from the network', () => {
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u, 'icons must be SVG, not emoji');
  // An SVG data URI legitimately carries the xmlns URL, so match on what would
  // actually cause a fetch rather than on the substring "http".
  assert.doesNotMatch(
    html,
    /<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/i,
    'the page must not load anything from the network',
  );
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i, 'no remote CSS resources');
});

test('the sidebar mark still matches assets/keyward-mark.svg', () => {
  // The sprite is a copy of the asset's geometry, so it can drift from it.
  const asset = readFileSync(join(root, 'assets', 'keyward-mark.svg'), 'utf8');
  const paths = [...asset.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 3, 'expected the ring as two arcs, plus the keyhole stem');
  for (const d of paths) {
    assert.ok(html.includes(d), `mark path drifted from the asset: ${d}`);
  }
});

test('the inlined favicon still matches assets/favicon.svg', () => {
  // The favicon is hand-inlined as a data URI, so it can silently drift from
  // the asset it was generated from.
  const asset = readFileSync(join(root, 'assets', 'favicon.svg'), 'utf8');
  const paths = [...asset.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 3, 'expected the ring as two arcs, plus the keyhole stem');
  for (const d of paths) {
    assert.ok(html.includes(d), `favicon path drifted from the asset: ${d}`);
  }
});

test('IsThereAnyDeal is credited wherever their data is shown', () => {
  // Attribution is a condition of using their API, not a courtesy.
  assert.match(html, /IsThereAnyDeal/);
  assert.match(html, /href="https:\/\/isthereanydeal\.com"/);
});

test('the ITAD setup flow points at the real registration page', () => {
  assert.match(html, /isthereanydeal\.com\/apps\/my/);
  assert.match(inlineScript(), /itad-setup/);
});

test('dialog failures render in the dialog, not as a toast', () => {
  const script = inlineScript();
  // A toast for a form error disappears, does not say which field was wrong,
  // and leaves the form looking accepted.
  assert.match(script, /function dialogError/);
  assert.match(script, /id="dlg-error"/);
  assert.match(script, /dialogError\(e\.message\)/);
});

test('a rejected saved key reopens the setup dialog', () => {
  // Otherwise a bad stored key fails identically on every scan with nothing
  // the user can act on.
  assert.match(inlineScript(), /e\.needsKey.*openItadSetup/s);
});

test('user-supplied values go through the escaper', () => {
  const script = inlineScript();
  // Recipient names, shop names and campaign labels are all attacker-adjacent
  // (a CSV someone else wrote), so they must never reach innerHTML raw.
  assert.match(script, /const esc = /);
  // Match on the field rather than the loop variable, so renaming a callback
  // parameter does not fail the test while a genuine hole would.
  assert.match(script, /esc\(\w+\.recipient\)/, 'recipient names must be escaped');
  assert.match(script, /esc\(\w+\.shop_name\)/, 'shop names must be escaped');
  assert.match(script, /esc\(\w+\.name\)/, 'contact names must be escaped');
  assert.match(script, /esc\(\w+\.batch\)/, 'batch names must be escaped');
});
