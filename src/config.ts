import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_THRESHOLDS, type Thresholds } from './rules.js';

export interface Config {
  /** IsThereAnyDeal API key. Free, from https://isthereanydeal.com/apps/my/ */
  itadKey?: string;
  /** Two-letter country used for ITAD price lookups. */
  country?: string;
  /** Path to the local database. */
  dbPath?: string;
  /** Overrides for the suspect rules. Anything absent uses the default. */
  rules?: Partial<Thresholds>;
  /**
   * Where `keyward watch` posts new findings. Setting this is the one thing
   * that sends your data off the machine, so it is never filled in for you.
   */
  webhookUrl?: string;
  /** scrypt hash of the web UI password, if one has been set. */
  passwordHash?: string;
  passwordSalt?: string;
}

/**
 * Resolved on each call rather than at import. Reading the environment once
 * when the module loads makes the path impossible to redirect afterwards,
 * which is awkward to test and surprising if anything ever changes HOME.
 */
const configDir = (): string => join(homedir(), '.config', 'keyward');

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    // No file yet, or someone saved it mid-edit. Neither is worth a word.
    return {};
  }
  /*
    JSON.parse is happy to return null, a number or an array, and a config file
    holding `null` crashed the next line that read a field off it. It is a file
    a person is invited to open, so anything can be in there.
  */
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  /*
    Drop the fields that are the wrong type rather than keeping only the ones
    named here. A whitelist looks tidier and quietly deleted the stored password
    the first time it was written, because saveConfig merges onto whatever this
    returns.
  */
  const config = { ...(parsed as Record<string, unknown>) };
  for (const field of ['itadKey', 'country', 'dbPath', 'webhookUrl', 'passwordHash', 'passwordSalt']) {
    if (field in config && typeof config[field] !== 'string') delete config[field];
  }
  if ('rules' in config) {
    const raw = config['rules'];
    const rules: Record<string, number> = {};
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) rules[name] = value;
      }
    }
    config['rules'] = rules;
  }
  return config as Config;
}

export function saveConfig(patch: Config): Config {
  const merged = { ...loadConfig(), ...patch };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

export function dbPath(override?: string): string {
  return override ?? process.env['KEYWARD_DB'] ?? loadConfig().dbPath ?? join(configDir(), 'keyward.db');
}

/** Kept separate from the real database so seeding can never touch live data. */
export function demoDbPath(): string {
  return join(configDir(), 'demo.db');
}

export function country(override?: string): string {
  return override ?? loadConfig().country ?? 'US';
}

/**
 * Thresholds are meant to be tuned. What counts as an odd number of dormant
 * keys depends entirely on how a studio hands them out, and a rule that fires
 * on everyone is worth nothing.
 */
export function thresholds(overrides: Partial<Thresholds> = {}): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...(loadConfig().rules ?? {}), ...overrides };
}

export function itadKey(): string {
  const key = process.env['KEYWARD_ITAD_KEY'] ?? loadConfig().itadKey;
  if (!key) {
    throw new Error(
      'Looking for prices needs an IsThereAnyDeal API key. It is free and takes a minute:\n\n' +
        '  1. Create an account at https://isthereanydeal.com and verify the email.\n' +
        '     Verified accounts get 1000 requests every 5 minutes.\n' +
        '  2. Register an app at https://isthereanydeal.com/apps/my/. That page gives you\n' +
        '     an API key and OAuth credentials; keyward only wants the API key.\n' +
        '  3. keyward config set --itad-key <key>\n\n' +
        'Or set KEYWARD_ITAD_KEY in the environment to keep it out of the config file.',
    );
  }
  return key;
}
