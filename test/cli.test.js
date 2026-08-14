import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every other test imports the command functions directly, which means a
 * command can be fully implemented and still be unreachable because nothing
 * routes to it. That happened once. These run the binary.
 *
 * HOME is redirected so the demo seeder writes into a temp directory instead
 * of the developer's real ~/.config/keyward.
 *
 * Every demo run passes --no-icons. Seeding otherwise fetches each shop's logo
 * over the network, which makes the suite slow, non-deterministic, and unable
 * to run offline.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(root, 'dist', 'cli.js');

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'keyward-home-'));
  try {
    const run = (args, opts = {}) =>
      execFileSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      });
    return fn(run, join(home, '.config', 'keyward', 'demo.db'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('bare invocation prints usage', () => {
  withHome((run) => assert.match(run([]), /keyward game add/));
});

test('demo seeds, and refuses to re-seed without --force', () => {
  withHome((run, demoDb) => {
    const first = run(['demo', '--no-icons']);
    assert.match(first, /Seeded 3 games/);
    assert.match(first, /Everything in it is invented/);
    assert.doesNotMatch(first, /keyward game add --name/, 'must not fall through to usage');

    assert.throws(() => run(['demo', '--no-icons']), /already has data/);
    assert.match(run(['demo', '--force', '--no-icons']), /Seeded 3 games/);

    // And the seeded database is actually readable by the normal commands.
    const report = run(['report', '--game', 'Lanternfall', '--db', demoDb]);
    assert.match(report, /Lanternfall/);
    assert.match(report, /Instant Gaming/);
    assert.match(report, /Halcyon Distribution/);
    assert.match(report, /shortlist/i, 'the report must qualify what it is showing');
  });
});

test('re-seeding after a sighting leaves a coherent database', () => {
  // A sighting references a key, so wiping in the wrong order fails on the
  // foreign key and used to leave 310 keys with zero assignments — a database
  // that still opened and reported nonsense.
  withHome((run, demoDb) => {
    run(['demo', '--no-icons']);
    const key = run(['report', '--game', 'Lanternfall', '--json', '--db', demoDb]);
    const suspect = JSON.parse(key).suspects[0].key;
    run(['trace', suspect, '--seen-on', 'Instant Gaming', '--db', demoDb]);

    run(['demo', '--force', '--no-icons']);
    const after = JSON.parse(run(['report', '--game', 'Lanternfall', '--json', '--db', demoDb]));
    assert.ok(after.totals.assigned > 100, `assignments were wiped: ${after.totals.assigned}`);
    assert.equal(
      after.findings.filter((f) => f.rule === 'confirmed-on-sale').length,
      0,
      'the old sighting must not survive and re-attach to an unrelated key',
    );
  });
});

test('demo never writes to the real database path', () => {
  withHome((run, demoDb) => {
    run(['demo', '--no-icons']);
    assert.match(demoDb, /demo\.db$/);
    // The default database is a different file and stays empty.
    assert.match(run(['game', 'list']), /No games yet/);
  });
});

test('an obviously wrong API key is refused and nothing is written', () => {
  // Short-circuits before any network call, so this stays deterministic.
  withHome((run, demoDb) => {
    assert.throws(() => run(['config', 'set', '--itad-key', 'abc']), /too short/);
    assert.throws(() => run(['config', 'set', '--itad-key', 'abc']), /--no-verify/);
    // A rejected key must not reach the config file — the whole point is that
    // the failure happens here rather than later as a broken scan.
    assert.equal(existsSync(join(dirname(demoDb), 'config.json')), false);
  });
});

test('--no-verify saves without checking, for offline setup', () => {
  withHome((run, demoDb) => {
    run(['config', 'set', '--itad-key', 'offline-placeholder', '--no-verify']);
    const cfg = JSON.parse(readFileSync(join(dirname(demoDb), 'config.json'), 'utf8'));
    assert.equal(cfg.itadKey, 'offline-placeholder');
  });
});

test('an unknown command exits non-zero rather than doing nothing', () => {
  withHome((run) => {
    assert.throws(() => run(['frobnicate']), (e) => e.status === 1);
  });
});

test('a missing required flag reports which one', () => {
  withHome((run) => {
    assert.throws(() => run(['report']), /Missing required --game/);
  });
});

test('a config file holding anything at all still opens', () => {
  // config.json is a file people are invited to edit, so it can hold anything.
  // `null` used to crash on the next line that read a field off it.
  for (const contents of ['null', '[1,2,3]', '42', 'not json', '', '{"rules":"none","country":5}']) {
    withHome((run, demoDb) => {
      const configDir = dirname(demoDb);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), contents);
      const out = run(['game', 'list']);
      assert.match(out, /no games/i, `a config of ${contents} produced: ${out.slice(0, 90)}`);
    });
  }
});
