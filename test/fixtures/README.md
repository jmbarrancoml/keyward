# Fixtures

**These are synthetic.** They reproduce the page shape that public Steamworks
batch-query scripts have relied on for years — an `<h2>Activation Details</h2>`
heading followed by a table — but none of them came off a live
`partner.steamgames.com` response, because writing this tool did not require a
Steamworks partner account.

That makes the parser the one part of keyward that is **unvalidated against
reality**. Before trusting `keyward check`, someone with partner access should:

1. Query one activated key and one unredeemed key through the Steamworks UI.
2. Save both responses here, with the key, the account name and any studio
   identifiers replaced by placeholders.
3. Run `npm test` and fix `src/steamworks/parse.ts` until they pass.

If Valve's markup differs from what is assumed here, `parseActivationDetails`
returns `status: 'unknown'` and keeps every table cell it found in `cells`, so
the mismatch shows up as unknowns in `keyward report` rather than as silently
wrong data. That is deliberate: guessing wrong about whether a reviewer redeemed
their key is how a studio ends up accusing the wrong person.
