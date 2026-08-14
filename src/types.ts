export type ActivationStatus =
  | 'activated'
  | 'not_activated'
  | 'invalid'
  | 'revoked'
  | 'unknown';

/** Result of parsing one Steamworks `querycdkey` response. */
export interface ActivationDetails {
  status: ActivationStatus;
  /** Steam account the key was activated on, when the page reports it. */
  account?: string;
  /** Raw date string as printed by Steamworks; not normalised on purpose. */
  activatedAt?: string;
  /** Every table cell we found, kept so an unexpected page shape is debuggable. */
  cells: string[];
}

export interface Game {
  id: number;
  name: string;
  steam_appid: number | null;
  itad_id: string | null;
}

export interface Recipient {
  id: number;
  name: string;
  email: string | null;
  kind: string;
  handle: string | null;
  note: string | null;
}

export interface Listing {
  shop_name: string;
  price: number;
  currency: string;
  url: string | null;
  is_keyshop: 0 | 1;
  seen_at: string;
}

/** A key we have reason to believe was resold rather than used. */
export interface Suspect {
  key: string;
  recipient: string;
  recipient_handle: string | null;
  campaign: string | null;
  assigned_at: string;
  days_dormant: number;
  last_status: ActivationStatus | null;
}
