# Security

keyward asks you for two things worth stealing: a ledger of unredeemed game
keys, and a Steamworks session cookie that can act as your studio. This is what
it does with them, what it protects against, and what it does not.

## Reporting something

Open a [private security advisory](https://github.com/jmbarrancoml/keyward/security/advisories/new).
Please do not open a public issue for anything exploitable.

There is no bounty. There is a maintainer who will read it.

## What keyward talks to

The complete list. Nothing else is contacted, ever.

| Host | When | Carrying |
| --- | --- | --- |
| `partner.steamgames.com` | `keyward check` | Your session cookie and one key at a time |
| `api.isthereanydeal.com` | `keyward scan` | Your API key and a game id |
| A shop's own domain | First scan only | Nothing. Fetching its favicon |
| `cdn.*.steamstatic.com` | Adding a game with an appid | Nothing. Fetching its store art |
| Your webhook | `keyward watch`, only if you set one | New findings, including contact names |

The browser page itself contacts nothing. It runs under a Content Security
Policy with `default-src 'none'`, and shop logos and store art are downloaded by
the local server and stored as data URIs so the page never reaches out. This is
[tested](test/design.test.js), not just intended.

There is no telemetry, no analytics, no update check, and no crash reporting.

## Where secrets live

keyward holds two: the Steamworks session cookie, and the database key if you
ran `keyward encrypt`. Neither goes in the config file or the database.

| Platform | Store | How |
|---|---|---|
| macOS | login keychain | `security` |
| Windows | DPAPI, tied to your Windows account | Windows PowerShell, ciphertext under `~/.config/keyward/secrets` |
| Linux | libsecret, so GNOME Keyring or KWallet | `secret-tool` |

No native module and no dependency: each is the command line the platform
already ships. Where none of them is available, keyward refuses to persist the
secret and reads it from the environment instead.

The macOS path passes the secret to `security` as an argument, so it is visible
in the process list for the length of one exec. `security` offers no other way.
The Windows and Linux paths both use stdin.


| Secret | Where | Why there |
| --- | --- | --- |
| Steamworks session cookie | OS keychain | It can act as your studio. It never touches the database or the config file, and on platforms without a keychain keyward refuses to persist it at all |
| IsThereAnyDeal API key | `~/.config/keyward/config.json`, mode 0600 | Read-only access to public pricing |
| Web UI password | Same file, as a salted scrypt hash | Never stored in the clear |
| Webhook URL | Same file | Treat it as a secret; anyone holding it can post to your channel |
| The key ledger | `~/.config/keyward/keyward.db`, mode 0600 | SQLite sets file modes from the umask, which is normally world-readable. keyward tightens it on every open, including the WAL sidecars |

## The local web UI

`keyward ui` runs an HTTP server. Every one of these is
[covered by a test](test/server.test.js):

- **Loopback only.** It binds `127.0.0.1`, never `0.0.0.0`, and that is not
  configurable.
- **A token per run**, 24 random bytes, required on every request and compared
  in constant time. It is minted at startup and dies when you stop the server.
- **The `Host` header is pinned.** A hostname that resolves to loopback cannot
  be used to reach the API from a page on someone else's domain.
- **Cross-origin requests are refused**, even carrying a valid token.
- **`frame-ancestors 'none'` and `X-Frame-Options: DENY`**, so nothing can frame
  it and click through you.
- **`Referrer-Policy: no-referrer`**, because the token is in the URL and must
  not travel to a shop link you click.
- **The live-reload endpoint does not exist** outside `--dev`. It holds a
  connection open and watches the filesystem.

### Why the token is in the URL

So that starting the server prints one thing you can click. It is in your
browser history for as long as that history lasts, but it stops working the
moment the server does, so a stale one is worth nothing. Moving it to a cookie
would take it out of the address bar and hand back the cross-site protection
that requiring a custom header currently gives for free. That trade is not worth
it here.

### The optional password

`keyward password set` puts a scrypt-hashed password in front of the browser,
with the session held in memory and ten wrong answers earning a five-minute
lockout.

**It gates the browser and nothing else.** By default the database is a plain
SQLite file that any viewer will open, and the CLI reads it without asking. To
cover the file itself, see below.

## Encryption at rest, if you ask for it

`keyward encrypt` seals the database with AES-256-GCM. The key is 32 random
bytes in the macOS keychain, so no command asks you for anything afterwards.

Nothing new got pulled in to do this. `node:sqlite` hands over the database as
bytes and takes it back the same way, so keyward decrypts into memory at open
time and writes the sealed file back after every change, through a temporary
file and a rename.

**What it closes.** The file leaving the machine: a copied database, a backup, a
Time Machine snapshot, a folder synced to Dropbox or iCloud, a `.db` attached to
a support ticket.

**What it does not.** Anything running as your user, which can ask the keychain
for the key the same way keyward does. And nothing at all while keyward is
running, because the database is decrypted in memory by then. Encryption at rest
is exactly that.

**What it costs you.** Three things, which is why it is off by default:

- Lose the key and the ledger is unreadable, by you as much as by anyone. The
  recovery code is printed once, at encryption time.
- The file stops being inspectable. No SQLite viewer, no `sqlite3` shell.
- SQLite's crash journal cannot protect a file it does not own. The write is
  atomic, so a crash mid-save leaves the previous database rather than a broken
  one, but a crash between two writes loses the last change.
- Only one keyward can hold it at a time. Saving checks that the file is still
  the one it read and refuses rather than overwrite another process's work.

`keyward decrypt` puts it back. `keyward restore-key <code>` re-seats the key on
another machine.

If your worry is a stolen laptop rather than a stray file, FileVault answers
that better, and the two stack.

## Supply chain

- **Zero runtime dependencies.** `package.json` declares none, and CI fails the
  build if that ever changes. What you are trusting is the code in `src/`.
- The build and test toolchain is TypeScript, Playwright and `@types/node`, all
  pinned in `package-lock.json`. CI installs with `npm ci` and runs `npm audit`.
- keyward downloads no code at runtime and evaluates nothing it fetches. The
  only things it downloads are images, which it stores and re-serves as data.

## What it does not protect you from

Said plainly, because a security page that only lists wins is not one.

- **Anyone with your user account.** The ledger and the config are readable by
  you, so they are readable by anything running as you. Encryption does not
  change this: the keychain answers that process too.
- **A stolen or unlocked machine.** Use FileVault, or your platform's
  equivalent. `keyward encrypt` covers the file at rest, not a machine someone
  is already sitting in front of.
- **A malicious dependency of the toolchain**, if you build from source with a
  compromised npm. The lockfile and `npm ci` narrow this; they do not close it.
- **Your Steamworks account itself.** keyward drives the same web page you would
  click, using your own session. If that session is stolen elsewhere, keyward is
  not the problem and cannot be the fix.
- **The webhook.** If you set one, findings leave your machine to a third party
  under their terms, including the names of contacts. It is off by default and
  it stays off unless you turn it on.

## A note on what the tool asserts

Not a vulnerability, but the thing most likely to do real harm: keyward's
findings are, with one exception, patterns rather than proof. It says so on
every surface that shows them. A studio that publicly accuses the wrong
journalist because a tool sounded certain does more damage than the leak did,
and no amount of hardening addresses that.
