import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where keyward keeps the two secrets it holds: the Steamworks session cookie,
 * which is a live partner credential, and the database key, if you encrypted
 * the database.
 *
 * Neither ever goes in the config file or the database. Each platform has
 * something for this already, so keyward drives that rather than inventing a
 * store of its own, and it drives it through the command line rather than a
 * native module, because a native module would be the first dependency in a
 * tool whose argument is that it has none.
 *
 *   macOS    the login keychain, through `security`
 *   Windows  DPAPI, through Windows PowerShell. The ciphertext sits in a file
 *            under ~/.config/keyward/secrets and only your Windows account can
 *            decrypt it.
 *   Linux    libsecret, through `secret-tool`, which is what GNOME Keyring and
 *            KWallet both speak.
 *
 * If none of that is available, every command still works by reading the secret
 * from the environment. Nothing here is required.
 */

export interface Keystore {
  readonly name: string;
  keep(service: string, value: string): void;
  recall(service: string): string | null;
  forget(service: string): void;
}

const ACCOUNT = 'keyward';

/* ---------- macOS ---------- */

export const macKeystore: Keystore = {
  name: 'the macOS keychain',

  keep(service, value) {
    // -w takes the secret on the command line, where other processes can read
    // it. `security` offers no way round that, so the window is one exec.
    execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', value], {
      stdio: 'pipe',
    });
  },

  recall(service) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  },

  forget(service) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT], {
        stdio: 'ignore',
      });
    } catch {
      /* nothing stored */
    }
  },
};

/* ---------- Windows ---------- */

const secretsDir = (): string => join(homedir(), '.config', 'keyward', 'secrets');
const secretFile = (service: string): string => join(secretsDir(), `${service}.dpapi`);

/**
 * DPAPI ties the ciphertext to the Windows account, so it needs no password and
 * no keyring daemon. Everything crossing the process boundary is base64: the
 * script goes in as UTF-16 through -EncodedCommand, which sidesteps quoting
 * entirely, and the secret goes in on stdin, so it never appears in a command
 * line the way the macOS one briefly does.
 */
function dpapi(direction: 'Protect' | 'Unprotect', input: string): string {
  const script = `
    Add-Type -AssemblyName System.Security
    $ErrorActionPreference = 'Stop'
    $in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $out = [System.Security.Cryptography.ProtectedData]::${direction}(
      $in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($out))
  `;
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

export const windowsKeystore: Keystore = {
  name: 'Windows DPAPI',

  keep(service, value) {
    const blob = dpapi('Protect', Buffer.from(value, 'utf8').toString('base64'));
    mkdirSync(secretsDir(), { recursive: true });
    writeFileSync(secretFile(service), blob, { mode: 0o600 });
  },

  recall(service) {
    const file = secretFile(service);
    if (!existsSync(file)) return null;
    try {
      const plain = dpapi('Unprotect', readFileSync(file, 'utf8').trim());
      return Buffer.from(plain, 'base64').toString('utf8') || null;
    } catch {
      // Another Windows account, a restored profile, or a corrupt file. Saying
      // nothing is stored is true enough: this one cannot read it.
      return null;
    }
  },

  forget(service) {
    rmSync(secretFile(service), { force: true });
  },
};

/* ---------- Linux ---------- */

export const secretToolKeystore: Keystore = {
  name: 'your keyring, through secret-tool',

  keep(service, value) {
    execFileSync('secret-tool', ['store', '--label', `keyward: ${service}`, 'service', service, 'account', ACCOUNT], {
      input: value,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  },

  recall(service) {
    try {
      const out = execFileSync('secret-tool', ['lookup', 'service', service, 'account', ACCOUNT], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  },

  forget(service) {
    try {
      execFileSync('secret-tool', ['clear', 'service', service, 'account', ACCOUNT], { stdio: 'ignore' });
    } catch {
      /* nothing stored */
    }
  },
};

/* ---------- picking one ---------- */

const NONE = 'no keystore';

/** What this machine offers, if anything. */
export function keystore(platform: string = process.platform): Keystore | null {
  if (platform === 'darwin') return macKeystore;
  if (platform === 'win32') return windowsKeystore;
  if (platform === 'linux' && has('secret-tool')) return secretToolKeystore;
  return null;
}

function has(command: string): boolean {
  try {
    // Through sh rather than a shell option, so the name is an argument and
    // never part of a string anything gets to interpret.
    execFileSync('/bin/sh', ['-c', `command -v "$1"`, 'sh', command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const keystoreName = (): string => keystore()?.name ?? NONE;

/**
 * Why there is nowhere to put it, and what to do instead. Worth being specific:
 * "unsupported platform" tells someone on Debian nothing, when one apt install
 * fixes it.
 */
export function noKeystoreReason(envVar: string, example: string): string {
  const install =
    process.platform === 'linux'
      ? 'No keyring here. secret-tool would give keyward one:\n' +
        '  apt install libsecret-tools     # or dnf install libsecret\n\n' +
        'Or keep it in the environment instead:\n'
      : `keyward has nowhere to keep a secret on ${process.platform}.\n` +
        'Keep it in the environment instead:\n';
  return `${install}\n  export ${envVar}=${example}`;
}
