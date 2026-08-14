import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  keystore, macKeystore, windowsKeystore, secretToolKeystore, noKeystoreReason,
} from '../dist/keystore.js';

const WINDOWS = process.platform === 'win32';

test('each platform gets the store it actually has', () => {
  assert.equal(keystore('darwin'), macKeystore);
  assert.equal(keystore('win32'), windowsKeystore);
  assert.equal(keystore('sunos'), null, 'anything unknown has to fall back, not throw');
  // Linux depends on secret-tool being installed, so only the two outcomes are
  // fixed: the libsecret store, or nothing.
  const linux = keystore('linux');
  assert.ok(linux === secretToolKeystore || linux === null);
});

test('with nowhere to put a secret, the message says what to do instead', () => {
  const reason = noKeystoreReason('KEYWARD_DB_KEY', 'abc123');
  assert.match(reason, /export KEYWARD_DB_KEY=abc123/);
  if (process.platform === 'linux') {
    assert.match(reason, /libsecret/, 'on Debian one apt install fixes it, so say so');
  }
});

/*
  On Windows the test below runs against real DPAPI. Everywhere else, a stand-in
  powershell.exe takes its place, which still exercises everything keyward
  controls: the argument shape, the UTF-16 -EncodedCommand, the secret going in
  over stdin rather than the command line, and the base64 on both sides.
*/
function withFakePowershell(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-ps-'));
  const exe = join(dir, 'powershell.exe');
  writeFileSync(
    exe,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || args[2] !== '-EncodedCommand') {
  console.error('unexpected arguments: ' + args.join(' '));
  process.exit(2);
}
const script = Buffer.from(args[3], 'base64').toString('utf16le');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.from(chunks.join('').trim(), 'base64');
  if (script.includes('::Protect(')) {
    process.stdout.write(Buffer.concat([Buffer.from('DPAPI'), input]).toString('base64'));
  } else if (script.includes('::Unprotect(')) {
    if (input.subarray(0, 5).toString() !== 'DPAPI') { process.exit(1); }
    process.stdout.write(input.subarray(5).toString('base64'));
  } else {
    process.exit(3);
  }
});
`,
    { mode: 0o755 },
  );
  chmodSync(exe, 0o755);

  const home = mkdtempSync(join(tmpdir(), 'keyward-home-'));
  const path = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.PATH = `${dir}:${path}`;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.PATH = path;
    process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test('the Windows store hands the secret to DPAPI and gets it back', { skip: WINDOWS }, () => {
  withFakePowershell((home) => {
    const secret = 'sessionid=abc; steamLoginSecure=def';
    windowsKeystore.keep('keyward-steamworks', secret);

    const file = join(home, '.config', 'keyward', 'secrets', 'keyward-steamworks.dpapi');
    assert.ok(existsSync(file), 'the protected blob goes beside the config');
    assert.equal(readFileSync(file, 'utf8').includes('steamLoginSecure'), false);

    assert.equal(windowsKeystore.recall('keyward-steamworks'), secret);
    windowsKeystore.forget('keyward-steamworks');
    assert.equal(windowsKeystore.recall('keyward-steamworks'), null);
  });
});

test('a blob this account cannot decrypt reads as nothing stored', { skip: WINDOWS }, () => {
  // A restored profile, or another Windows account's file. Throwing here would
  // break every command; returning null sends the caller to the env var.
  withFakePowershell((home) => {
    windowsKeystore.keep('keyward-database', 'deadbeef');
    const file = join(home, '.config', 'keyward', 'secrets', 'keyward-database.dpapi');
    writeFileSync(file, Buffer.from('not yours').toString('base64'));
    assert.equal(windowsKeystore.recall('keyward-database'), null);
  });
});

test('DPAPI keeps a real secret', { skip: !WINDOWS && 'Windows only' }, () => {
  const service = 'keyward-test';
  const secret = 'sessionid=abc; steamLoginSecure=def';
  try {
    windowsKeystore.keep(service, secret);
    assert.equal(windowsKeystore.recall(service), secret);

    const file = join(homedir(), '.config', 'keyward', 'secrets', `${service}.dpapi`);
    assert.equal(readFileSync(file, 'utf8').includes('steamLoginSecure'), false);
  } finally {
    windowsKeystore.forget(service);
  }
  assert.equal(windowsKeystore.recall(service), null);
});
