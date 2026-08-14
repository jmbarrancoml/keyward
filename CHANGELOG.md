# Changelog

## Unreleased

First public version. Nothing has shipped under a version number yet, so there
is no upgrade path to describe.

What works today: the ledger of games, batches, keys and contacts on both the
CLI and a local web UI; six rules over that ledger with tunable thresholds;
prices from IsThereAnyDeal; key import from a Steamworks zip, a CSV, or text
pasted from anywhere; tracing a key you bought back to the person you sent it
to; `watch` for cron with desktop notifications and an optional webhook; CSV
export of everything; and `keyward encrypt` for AES-256-GCM over the database at
rest, with the key in the keychain.

What does not: `keyward check` drives a Steamworks page that has never been
validated against a live response. See the README.
