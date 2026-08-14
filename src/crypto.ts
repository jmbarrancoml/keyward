import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { keystore, keystoreName, noKeystoreReason } from './keystore.js';

/**
 * Optional encryption of the database at rest.
 *
 * What it closes: a copied file, a leaked backup, a Time Machine snapshot, a
 * folder synced to Dropbox or iCloud, a `.db` attached to a support ticket. The
 * file on its own is useless.
 *
 * What it does not: anything running as you, which can ask the keychain the
 * same way keyward does, and anything at all while keyward is open, because the
 * decrypted database is then in memory. Encryption at rest is exactly that.
 *
 * The key is 32 random bytes kept wherever the platform keeps secrets (see
 * keystore.ts), so opening the database needs no password typed. There is no key
 * derivation because there is no passphrase to stretch. You are also shown the
 * key once, as a recovery code, because a keystore that goes away otherwise
 * takes the ledger with it.
 */

const MAGIC = Buffer.from('KWENC1\0\0', 'latin1');
const SERVICE = 'keyward-database';

export function isEncrypted(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function seal(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function unseal(blob: Buffer, key: Buffer): Buffer {
  if (!isEncrypted(blob)) throw new Error('That file is not an encrypted keyward database.');
  const iv = blob.subarray(8, 20);
  const tag = blob.subarray(20, 36);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(36)), decipher.final()]);
  } catch {
    // GCM fails closed: a wrong key and a tampered file look the same, which is
    // the point.
    throw new Error(
      'The database would not decrypt. Either the key is wrong or the file has been altered.',
    );
  }
}

/* ---------- where the key lives ---------- */

export const newKey = (): Buffer => randomBytes(32);

/** Groups of four, which divide 64 evenly, so no group is short at the end. */
export function recoveryCode(key: Buffer): string {
  return (key.toString('hex').toUpperCase().match(/.{4}/g) ?? []).join('-');
}

export function parseRecoveryCode(code: string): Buffer {
  const hex = code.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 64) throw new Error('A recovery code is 64 hex characters.');
  return Buffer.from(hex, 'hex');
}

/** Where the key ended up, for the sentence printed after encrypting. */
export const keyHome = (): string => keystoreName();

export function storeKey(key: Buffer): void {
  const store = keystore();
  if (!store) throw new Error(noKeystoreReason('KEYWARD_DB_KEY', key.toString('hex')));
  store.keep(SERVICE, key.toString('hex'));
}

export function loadKey(): Buffer {
  const fromEnv = process.env['KEYWARD_DB_KEY'];
  if (fromEnv) return parseRecoveryCode(fromEnv);

  const hex = keystore()?.recall(SERVICE);
  if (hex) return parseRecoveryCode(hex);

  throw new Error(
    'This database is encrypted and the key is not available.\n\n' +
      `It normally lives in ${keystoreName()}. If this is a different machine, or\n` +
      'that store has been lost, supply the recovery code you were shown:\n\n' +
      '  export KEYWARD_DB_KEY=<the code, dashes and all>\n\n' +
      'Without it the database cannot be read, by you or anyone else.',
  );
}

export function forgetKey(): void {
  keystore()?.forget(SERVICE);
}
