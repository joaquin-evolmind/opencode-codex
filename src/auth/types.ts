export interface OauthEntry {
  type: 'oauth';
  refresh: string;
  access: string;
  expires: number;
  localId?: string;
  accountId?: string;
  subject?: string;
  enterpriseUrl?: string;
}

export interface ApiEntry {
  type: 'api';
  key: string;
  metadata?: Record<string, string>;
}

export type Entry =
  | OauthEntry
  | ApiEntry
  | { type: string; [k: string]: unknown };
