import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadConfig, saveConfig } from './config.js';

/**
 * A password for the web UI.
 *
 * Be clear about what this does. It stops someone sitting at an unlocked
 * machine from reading the ledger through the browser. It does not protect the
 * database and it does not gate the CLI. For the file itself there is
 * `keyward encrypt`, which seals it at rest; see src/crypto.ts.
 *
 * The Steamworks cookie, which is the genuinely dangerous secret here, lives in
 * the OS keychain and is already behind the system login.
 *
 * scrypt from node:crypto, so no dependency and no home-made hashing.
 */

const KEY_LENGTH = 64;
// Cost chosen so a check takes a noticeable fraction of a second on a laptop,
// which is what makes guessing expensive.
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hasPassword(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.passwordHash && cfg.passwordSalt);
}

export function setPassword(plain: string): void {
  const password = plain.trim();
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT).toString('hex');
  saveConfig({ passwordHash: hash, passwordSalt: salt });
}

export function clearPassword(): void {
  const cfg = loadConfig();
  delete cfg.passwordHash;
  delete cfg.passwordSalt;
  // saveConfig merges, so the keys have to be written as undefined to go away.
  saveConfig({ passwordHash: undefined, passwordSalt: undefined } as never);
}

export function checkPassword(plain: string): boolean {
  const { passwordHash, passwordSalt } = loadConfig();
  if (!passwordHash || !passwordSalt) return true; // nothing set, nothing to fail

  const candidate = scryptSync(plain, passwordSalt, KEY_LENGTH, SCRYPT);
  const stored = Buffer.from(passwordHash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}
