import { keystore, keystoreName, noKeystoreReason } from './keystore.js';

/**
 * The Steamworks session cookie is a live partner credential: anyone holding it
 * can act as the studio inside Steamworks. It never touches the config file or
 * the database. It goes wherever the platform keeps secrets (see keystore.ts),
 * and where there is no such place, keyward refuses to persist it and reads it
 * from the environment instead.
 */

const SERVICE = 'keyward-steamworks';

export function setSteamCookie(cookie: string): void {
  const store = keystore();
  if (!store) throw new Error(noKeystoreReason('KEYWARD_STEAM_COOKIE', '"sessionid=...; steamLoginSecure=..."'));
  store.keep(SERVICE, cookie);
}

export function getSteamCookie(): string {
  const fromEnv = process.env['KEYWARD_STEAM_COOKIE'];
  if (fromEnv) return fromEnv;

  const stored = keystore()?.recall(SERVICE);
  if (stored) return stored;

  throw new Error(
    'No Steamworks session cookie found.\n\n' +
      'Log in at https://partner.steamgames.com, open DevTools > Network, click any\n' +
      'Steamworks link, and copy the `Cookie:` request header (it must contain\n' +
      '`sessionid` and `steamLoginSecure`). Then:\n\n' +
      `  keyward auth set            # reads it from stdin, keeps it in ${keystoreName()}\n` +
      '  export KEYWARD_STEAM_COOKIE="..."   # or keep it in the shell only',
  );
}

export function clearSteamCookie(): void {
  keystore()?.forget(SERVICE);
}
