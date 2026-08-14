# Contributing

```sh
npm install
npm test              # the unit tests, offline, about 40 seconds
npm run dev:demo      # the UI against demo data, reloading as you save
npm run verify        # everything below, in order, about four minutes
```

Node 24 or newer. There is no build toolchain to install and no services to run.

## The one thing that would help most

**The Steamworks activation parser has never run against a live response.** It
drives `partner.steamgames.com/querycdkey`, which Valve does not document, and
it was written against the page shape that public batch-query scripts have used
for years. Four of the six rules depend on it.

If you have Steamworks partner access, two anonymised responses close this: one
key that has been redeemed and one that has not. Replace the key, the account
name and anything identifying, drop them in `test/fixtures/`, and run the tests.
[`test/fixtures/README.md`](test/fixtures/README.md) has the details.

## What the tests are for

Most of them exist because something was wrong once. A few are worth knowing
about before you change things:

- `test/design.test.js` parses the stylesheet and recomputes every colour
  contrast pairing, checks nothing drops below 13px, and asserts that the table
  header stays pinned and that sorting stays on the server. A previous palette
  failed WCAG AA in four places and no test noticed.
- `test/security.test.js` builds a real zip bomb and asserts that refusing it
  stays cheap, and that the database is not readable by other accounts.
- `test/crypto.test.js` covers the encrypted database end to end, including the
  two ways to lose data with it: a write that never reached `saveDb`, and WAL
  mode, which makes `serialize()` refuse and would break saving rather than
  opening.
- `test/cli.test.js` runs the binary. Every other test imports the command
  functions directly, which once let a fully implemented command ship with
  nothing routing to it.
- `test/rules.test.js` fails if a documented rule cannot fire on the demo data.
  A rule nobody can see demonstrates nothing.

## The four things `npm run verify` runs

The unit tests, and then four harnesses in `e2e/`. None of them mocks anything:
each starts a real server or runs the real binary. Together they have found ten
faults that the unit tests could not, and every one of them lived in the gap
between two pieces that were each correct on their own.

- **`npm run cli-matrix`** runs the binary 93 times with flags missing, flags
  misspelt, values that are not what the flag wants, and `--db` pointing at a
  folder, at a file that is not a database, and at somewhere unwritable. It
  asserts the answer rather than the failure: failing is often right, and a
  stack trace, SQLite's own words or an exit code of 0 on something that did not
  work never are.
- **`npm run probe`** puts 1,443 requests through every endpoint the wrong way
  round: no body, the wrong method, JSON that is not an object, a two megabyte
  body, `__proto__` as a sort column, `../../etc/passwd` as a path. Same rule,
  plus the server has to still be serving at the end and the ledger has to hold
  what it held at the start.
- **`npm run states`** is about situations rather than commands: a fresh install
  with no config, a config someone edited into nonsense, a database from an
  older version, an encrypted file that has been truncated, two processes at
  once, ten thousand keys, a half-finished encryption, the demo beside the real
  thing.
- **`npm run e2e`** drives Chromium through one journey, from an empty database
  to an encrypted one. It needs `npx playwright install chromium` once, which is
  why none of this is part of `npm test`.

Two worth keeping in mind if you change that area. Setting a password locked
everyone out of their own browser, because Chrome sends `Origin: null` for a
form navigation from a page served with `Referrer-Policy: no-referrer` and the
origin check refused it; every server test still passed. And the ledger exported
a contact called `=HYPERLINK(...)` as a live formula, which any spreadsheet runs
on open.

Tests never touch the network. `demo` fetches shop logos, so every test that
seeds it passes `--no-icons`.

**Anything new gets driven in both places before it counts.** Run the command,
then open the UI and click through the same thing. Four of the faults this
project has had lived in the gap between two layers that each worked: a batch
region that saved correctly, showed correctly in `batch list`, and rendered as a
dash in the browser, because the report query selected different columns from the
one the CLI used. The unit tests all passed.

## House rules

**Zero runtime dependencies.** CI fails the build if `package.json` grows a
`dependencies` entry. This is the argument for trusting a tool you hand a
Steamworks session cookie to, and it is worth more than any convenience a
library would buy. Dev dependencies are fine.

**The page loads nothing from the network.** Shop logos and store art are
fetched by the local server and stored as data. If you need an asset, inline it.

**Never overstate a finding.** With one exception, everything keyward reports is
a pattern, not proof. Every rule ships with the ordinary explanation alongside
it. A studio that publicly accuses the wrong journalist because a tool sounded
certain does more damage than the leak did, and no feature is worth that.

**Say it in plain words.** "Dormant", "signals" and `not_activated` all made it
to the screen once and meant nothing to the person the tool is for.

## Other things worth doing

- **Keyshop classification.** The name list in `src/itad/client.ts` is
  hand-written and will have gaps.
- **Console keys.** The same problem exists on Xbox, PlayStation and Switch, and
  none of them are modelled here.
- **Importers** for Keymailer, Lurkit and Terminals exports, so studios already
  using those do not have to re-key their history. Woovit was on this list until
  it shut down in December 2024, which is its own argument for keeping the
  ledger in a file you hold.
- **Windows, on a real machine.** DPAPI, the ACL on the database and the tray
  notification are all written and all run in CI, which is not the same as
  someone using them for a week. `src/keystore.ts` is where to look.

## Reporting a security issue

Not through an issue. See [SECURITY.md](SECURITY.md).
