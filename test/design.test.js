import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The UI shipped for a while with a washed-out third text tone that failed
 * WCAG AA in all four of its uses, and a type scale whose labels sat at 11px
 * against a 13px desktop minimum. Nothing caught either, because neither is
 * visible in a screenshot to someone who already knows what the text says.
 * These are the guards.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'src', 'ui', 'app.html'), 'utf8');
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

const hex = (h) => {
  h = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const channel = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (h) => {
  const [r, g, b] = hex(h).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Pull the token block for a theme: the base :root, or the dark-mode one. */
function tokens(dark) {
  const blocks = [...css.matchAll(/:root\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
  const source = dark ? blocks.slice(1).join('\n') : blocks[0];
  const base = Object.fromEntries(
    [...blocks[0].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
  );
  const over = Object.fromEntries(
    [...source.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
  );
  return { ...base, ...over };
}

const SURFACES = ['page', 'surface', 'sunken'];
const TEXTS = ['ink', 'ink-2'];

for (const dark of [false, true]) {
  test(`every text tone clears WCAG AA on every surface (${dark ? 'dark' : 'light'})`, () => {
    const t = tokens(dark);
    for (const fg of TEXTS) {
      for (const bg of SURFACES) {
        assert.ok(t[fg] && t[bg], `token --${fg} or --${bg} is missing`);
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(
          ratio >= 4.5,
          `--${fg} on --${bg} is ${ratio.toFixed(2)}:1, below the 4.5:1 needed at this size`,
        );
      }
    }
  });
}

test('there is no third, unreadable text tone to reach for', () => {
  // The failure mode was having a token that looked fine and was not. Removing
  // it is the fix; de-emphasis is size, weight and tracking instead.
  const t = tokens(false);
  const textish = Object.keys(t).filter((k) => /^(ink|text|muted|faint|dim)/.test(k));
  assert.deepEqual(textish.sort(), ['ink', 'ink-2'], `unexpected text tokens: ${textish}`);
});

test('nothing is set below the 13px desktop minimum', () => {
  const sizes = [
    ...[...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])),
    ...[...css.matchAll(/font:\s*(?:[\w]+\s+)?([\d.]+)px/g)].map((m) => Number(m[1])),
  ];
  assert.ok(sizes.length > 10, 'expected to find the type scale');
  const tooSmall = sizes.filter((s) => s < 13);
  assert.deepEqual(tooSmall, [], `sizes below the 13px minimum: ${tooSmall}`);
});

test('severity is encoded by stroke weight, since colour is not available', () => {
  // Monochrome is a hard constraint, so the one axis the product is organised
  // around has to be legible without hue. Each level needs its own weight.
  const widths = [...css.matchAll(/\.finding\[data-sev="(\w+)"\]::before\s*\{[^}]*width:\s*(\d+)px/g)]
    .map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(
    widths.map((w) => w[0]),
    ['certain', 'high', 'medium', 'low'],
    'every severity needs a gutter rule',
  );
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i - 1][1] > widths[i][1], 'gutter weight must taper as certainty drops');
  }
});

test('sections are separated by tone and space, never by a rule', () => {
  // A standing instruction from the owner, and easy to undo by accident. The
  // top-level containers are the verdict block and the disclosures.
  for (const selector of ['\\.verdict', '\\.card']) {
    const block = new RegExp(`(?:^|\\n)\\s*${selector}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(block, `expected a rule for ${selector}`);
    assert.match(block[1], /background:\s*var\(--surface\)/, `${selector} should carry its own tone`);
    assert.doesNotMatch(
      block[1],
      /border(?!-radius)/,
      `${selector} must be set apart by tone and space, not a border`,
    );
    assert.match(block[1], /margin-bottom/, `${selector} needs space beneath it`);
  }
});

test('the screen leads with one plain-language verdict', () => {
  // The complaint that prompted this layout was "too much information all the
  // time", answered by putting one sentence first and everything else on its
  // own tab.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /function verdict\(/, 'there must be a single answer at the top');
  assert.match(script, /TAB = TABS\.some/, 'the default tab must be validated, not trusted');
  assert.match(script, /viewOverview\(/, 'the verdict belongs to the overview tab');
});

test('every part of the data is reachable from the tab bar', () => {
  // Folding detail away made the tool feel like it was deciding what you were
  // allowed to see. The tab bar is the map; each entry needs a view behind it.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const entries = [...script.matchAll(/\{ id: '(\w+)', label: '[^']+', icon: '([a-z]+)' \}/g)];
  const tabs = entries.map((m) => m[1]);
  assert.deepEqual(tabs, ['overview', 'keys', 'contacts', 'batches', 'sale']);
  for (const t of tabs) {
    const view = 'view' + t[0].toUpperCase() + t.slice(1);
    assert.ok(script.includes(view + '('), `tab "${t}" has no ${view} to render`);
  }
  // Tab glyphs are referenced through a variable, so the generic icon check
  // cannot see them.
  for (const [, id, glyph] of entries) {
    assert.ok(html.includes(`<g id="i-${glyph}">`), `tab "${id}" points at a missing glyph "${glyph}"`);
  }
  // The words go on a narrow screen, so the glyph has to stand alone.
  assert.match(css, /\.tab-label\s*\{\s*display:\s*none/);
});

test('the keys view can show everything, not just the suspicious ones', () => {
  // "Ver todo lo que quiera" — the browse endpoints exist precisely so the
  // report's thresholds do not decide what is visible.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const filters = [...script.matchAll(/\['(\w+)', '[^']+'\]/g)].map((m) => m[1]);
  for (const f of ['all', 'redeemed', 'waiting', 'unchecked', 'unassigned']) {
    assert.ok(filters.includes(f), `the keys view needs an "${f}" filter`);
  }
  assert.match(script, /api\(`\/api\/keys/, 'the keys tab must query the server');
});

test('a key is never allowed to wrap mid-code', () => {
  // Joining keys into one run of text let a line break land inside one
  // ("GQ4QP-GWQCX-" / "VK948"), which makes it unreadable and uncopyable.
  const block = /\.keychip-code\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'expected a rule for the key code');
  assert.match(block[1], /white-space:\s*nowrap/);
});

test('every key on screen is the same component', () => {
  // A key is the one thing here you need to act on. Rendering it as bare text
  // anywhere makes it inert in that one place, which is where someone reaches
  // for it and finds nothing.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /function keyChip\(/);

  const uses = [...script.matchAll(/keyChip\(/g)].length;
  assert.ok(uses >= 5, `expected the component to be used throughout, found ${uses}`);

  // Copy on click, and a menu for everything else.
  assert.match(script, /data-act="copy-key"/);
  assert.match(script, /data-act="key-menu"/);
  assert.match(script, /function showKeyMenu\(/);
  for (const item of ['key-record', 'key-sighted']) {
    assert.ok(script.includes(`data-act="${item}"`), `the key menu needs a "${item}" action`);
  }
});

test('dates are written out, never left as raw ISO', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /function fmtDate\(/);
  assert.match(script, /MONTHS/, 'month names are spelled out rather than numbered');
  // day() returns the raw yyyy-mm-dd and should no longer reach a template.
  assert.doesNotMatch(script, /esc\(day\(/, 'a raw ISO date is being rendered');
});

test('shop logos are served from the database, never fetched by the page', () => {
  // The server fetches each shop's favicon once and stores it as a data URI.
  // If the page ever requested one directly it would break the CSP and tell
  // that resale site a studio is watching it.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /function shopMark\(name, icons\)/);
  assert.match(script, /icons\[name\]/, 'the logo must come from the report payload');
  assert.doesNotMatch(script, /<img[^>]+src="https?:/i, 'no remote image sources');
  assert.doesNotMatch(script, /icon\.horse|google\.com\/s2|duckduckgo\.com\/ip3/i, 'no icon proxy');
  // And the monogram has to survive as the fallback for shops without one.
  assert.match(script, /initial/);
});

test('how sure we are is read before the claim, and looks like a label', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const finding = /function renderFinding\(f\)[\s\S]*?\n\}/.exec(script)[0];
  const sev = finding.indexOf('class="sev"');
  const summary = finding.indexOf('esc(f.summary)');
  assert.ok(sev > -1 && summary > -1);
  assert.ok(sev < summary, 'the severity label must come before the summary');

  const block = /\.finding \.sev\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(block, /text-transform:\s*uppercase/, 'it should not read as a heading');
  assert.match(block, /letter-spacing/);
});

test('keys are masked on screen but copied in full', () => {
  // A full key on screen leaks through a screenshot, a shared window or a
  // recorded call — and this tool is opened precisely to discuss keys that got
  // out. Copy has to keep working on the whole thing or the peek is useless.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /function maskKey\(/);
  assert.match(script, /REVEALED/, 'there must be a way to reveal one deliberately');
  assert.match(script, /const shown = REVEALED\.has\(key\) \?/, 'the chip renders the masked form');
  // data-key carries the real key, which is what copy and the menu read.
  assert.match(script, /data-act="copy-key" data-key="\$\{k\}"/);
  assert.match(script, /data-act="key-reveal"/);
});

test('each severity has its own glyph, not just its own words', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /icon\('sev-' \+ f\.severity/);
  for (const sev of ['certain', 'high', 'medium', 'low']) {
    assert.ok(html.includes(`<g id="i-sev-${sev}">`), `severity "${sev}" has no glyph`);
  }
});

test('severity is spelled out, not left as a graphic to decode', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /SEVERITY_WORD/);
  for (const word of ['Confirmed', 'Very likely', 'Worth a look', 'Background']) {
    assert.ok(script.includes(word), `severity "${word}" needs a plain-language label`);
  }
});

test('a form label names the thing it is asking for', () => {
  // "Take it from" was a verb with no noun, and the sentence explaining it sat
  // at the foot of the dialog where it read as a note about the last field.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const labels = [...script.matchAll(/field\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length > 5, 'expected to find the dialog labels');
  for (const label of labels) {
    assert.doesNotMatch(
      label.replace(/<[^>]*>/g, '').trim(),
      /^(Take|Pick|Choose|Set|Enter|Add) it\b/i,
      `"${label}" tells you to do something without saying to what`,
    );
  }
  // Hints belong inside the field, attached to their control.
  assert.match(css, /\.hint\s*\{/);
  assert.match(script, /<p class="hint">/);
});

test('the interface avoids the vocabulary only its author knows', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  // These are internal names. They are fine in the CLI and the code; on screen
  // they meant nothing to the person the tool is for.
  for (const jargon of ['Dormant keys', 'Signals', 'Keyshops', 'Trace a key']) {
    assert.ok(!script.includes(`>${jargon}<`), `"${jargon}" is still shown as a heading`);
  }
});

test('only the content scrolls', () => {
  // The sidebar and the tab bar have to stay put, or you lose the game you are
  // in and the way to another tab while reading a long table.
  const layout = /\.layout\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(layout, /height:\s*100vh/);
  assert.match(layout, /overflow:\s*hidden/);
  assert.match(/\.side\s*\{([^}]*)\}/.exec(css)[1], /overflow-y:\s*auto/);
  assert.match(/\.main-scroll\s*\{([^}]*)\}/.exec(css)[1], /overflow-y:\s*auto/);
  // On a phone two independently scrolling panes are wrong; it goes back to one.
  const narrow = /@media \(max-width: 760px\)\s*\{([\s\S]*?)\n  \}/.exec(css)[1];
  assert.match(narrow, /\.layout\s*\{[^}]*height:\s*auto/);
});

test('a key shows where it came from without opening anything', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /function showPeek\(/);
  assert.match(script, /PEEK_CACHE/, 'hovering the same key twice should not re-query');
  assert.match(script, /function peekText\(/);
});

test('tables are a working surface, not a printout', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  // The header stays put while the rows move.
  assert.match(/thead th\s*\{([^}]*)\}/.exec(css)[1], /position:\s*sticky/);
  // Header and cells are told apart by tone, not by a rule.
  assert.match(/thead th\s*\{([^}]*)\}/.exec(css)[1], /background:\s*var\(--sunken\)/);
  // Rows respond to the pointer, so it is clear they are live.
  assert.match(css, /tbody tr:hover/);

  assert.match(script, /function sortHead\(/, 'columns must sort');
  assert.match(script, /function drill\(/, 'cells must narrow the view to themselves');
  assert.match(script, /function activeFilters\(/, 'an applied filter must be visible and undoable');
  for (const act of ['sort-keys', 'drill', 'clear-q', 'clear-filter']) {
    assert.ok(script.includes(`act === '${act}'`), `no handler for "${act}"`);
  }
});

test('all three tables sort, not just the keys one', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  for (const scope of ['keys', 'contacts', 'batches']) {
    assert.ok(script.includes(`sortHead('sort-${scope}'`), `the ${scope} table has no sortable header`);
    assert.ok(script.includes(`act === 'sort-${scope}'`), `no handler for sorting ${scope}`);
  }
});

test('the paginated table sorts on the server, the complete ones in the page', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  // Keys is capped, so sorting the slice the browser holds would reorder a
  // fraction of the data and present it as the whole answer.
  assert.match(script, /sort=\$\{KEYS_SORT\.sort\}/);
  assert.doesNotMatch(script, /data\.rows\.sort\(/, 'the fetched slice must not be re-sorted locally');

  // Contacts and Batches always arrive complete, so a local sort is honest and
  // saves a round trip.
  assert.match(script, /function sortRows\(/);
  assert.match(script, /sortRows\(matching, CONTACTS_SORT/);
  assert.match(script, /sortRows\(r\.batches, BATCHES_SORT/);
});

test('the quality floor is in place', () => {
  assert.match(css, /:focus-visible/, 'keyboard focus must be visible');
  assert.match(css, /prefers-reduced-motion/, 'motion must be reducible');
  assert.match(css, /@media\s*\(max-width/, 'the layout must survive a narrow window');
  assert.match(css, /prefers-color-scheme:\s*dark/, 'both appearances must be supported');
});

test('click targets meet the desktop minimum', () => {
  // HIG asks for 28x28pt on desktop, 20x20pt at the absolute minimum.
  const minHeights = [...css.matchAll(/min-height:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(minHeights.length >= 2, 'buttons and inputs should pin a minimum height');
  for (const h of minHeights) assert.ok(h >= 28, `${h}px is under the 28px desktop target`);
});
