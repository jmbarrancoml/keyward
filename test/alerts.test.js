import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { seedDemo } from '../dist/commands/demo.js';
import { buildReport } from '../dist/commands/report.js';
import { fingerprint, unseenFindings, markSeen } from '../dist/alerts.js';
import { setPassword, clearPassword, checkPassword, hasPassword } from '../dist/password.js';

function seeded(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-alert-'));
  const db = openDb(join(dir, 'a.db'));
  try {
    seedDemo(db);
    return fn(db, db.prepare("SELECT id FROM games WHERE name = 'Lanternfall'").get().id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a finding is new once, then stops being new', () => {
  // Telling you about the same problem on every run is how an alert becomes
  // something you stop reading.
  seeded((db, gameId) => {
    const { findings } = buildReport(db, { game: 'Lanternfall', dormantDays: 14 });
    assert.ok(findings.length > 0);

    assert.equal(unseenFindings(db, gameId, findings).length, findings.length);
    markSeen(db, gameId, findings);
    assert.equal(unseenFindings(db, gameId, findings).length, 0);
  });
});

test('the same problem getting worse counts as new again', () => {
  // A contact going from three unredeemed keys to seven is a new fact, so the
  // count is part of what is remembered.
  const before = { rule: 'dormant-cluster', subject: 'Halcyon', count: 3 };
  const after = { rule: 'dormant-cluster', subject: 'Halcyon', count: 7 };
  assert.notEqual(fingerprint(before), fingerprint(after));

  seeded((db, gameId) => {
    markSeen(db, gameId, [before]);
    assert.equal(unseenFindings(db, gameId, [before]).length, 0);
    assert.equal(unseenFindings(db, gameId, [after]).length, 1);
  });
});

test('what is seen for one game is not seen for another', () => {
  seeded((db, gameId) => {
    const other = db.prepare("SELECT id FROM games WHERE name = 'Tidewright'").get().id;
    const f = { rule: 'dormant-cluster', subject: 'Halcyon', count: 3 };
    markSeen(db, gameId, [f]);
    assert.equal(unseenFindings(db, other, [f]).length, 1);
  });
});

test('the report says how many are unseen', () => {
  seeded((db, gameId) => {
    const first = buildReport(db, { game: 'Lanternfall', dormantDays: 14 });
    assert.equal(first.unseen, first.findings.length);
    markSeen(db, gameId, first.findings);
    assert.equal(buildReport(db, { game: 'Lanternfall', dormantDays: 14 }).unseen, 0);
  });
});

/* ---------- the password on the web UI ---------- */

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'keyward-pw-'));
  // os.homedir() reads HOME on macOS and Linux and USERPROFILE on Windows, so
  // redirecting one of them only worked on two platforms out of three.
  const vars = ['HOME', 'USERPROFILE'];
  const before = vars.map((v) => process.env[v]);
  for (const v of vars) process.env[v] = home;
  try {
    return fn(home);
  } finally {
    vars.forEach((v, i) => {
      if (before[i] === undefined) delete process.env[v];
      else process.env[v] = before[i];
    });
    rmSync(home, { recursive: true, force: true });
  }
}

test('no password set means nothing to check', () => {
  withHome(() => {
    assert.equal(hasPassword(), false);
    assert.equal(checkPassword('anything at all'), true);
  });
});

test('a password is stored hashed and salted, never in the clear', () => {
  withHome(() => {
    setPassword('correct horse battery');
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.config', 'keyward', 'config.json'), 'utf8'),
    );
    assert.ok(cfg.passwordHash && cfg.passwordSalt);
    assert.doesNotMatch(JSON.stringify(cfg), /correct horse battery/, 'the password itself must not be on disk');
    assert.equal(cfg.passwordHash.length, 128, 'a 64-byte scrypt hash in hex');

    assert.equal(checkPassword('correct horse battery'), true);
    assert.equal(checkPassword('correct horse batteru'), false);
    assert.equal(checkPassword(''), false);
  });
});

test('the same password twice produces different stored hashes', () => {
  // Distinct salts, so two studios using the same password do not look alike.
  withHome(() => {
    setPassword('correct horse battery');
    const first = JSON.parse(
      readFileSync(join(homedir(), '.config', 'keyward', 'config.json'), 'utf8'),
    );
    setPassword('correct horse battery');
    const second = JSON.parse(
      readFileSync(join(homedir(), '.config', 'keyward', 'config.json'), 'utf8'),
    );
    assert.notEqual(first.passwordSalt, second.passwordSalt);
    assert.notEqual(first.passwordHash, second.passwordHash);
  });
});

test('a short password is refused', () => {
  withHome(() => assert.throws(() => setPassword('short'), /at least 8/));
});

test('clearing removes it', () => {
  withHome(() => {
    setPassword('correct horse battery');
    assert.equal(hasPassword(), true);
    clearPassword();
    assert.equal(hasPassword(), false);
  });
});
