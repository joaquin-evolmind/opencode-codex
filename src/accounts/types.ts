export interface UsageWindow {
  windowMinutes: number;
  usedPercent: number;
  resetAtMs: number;
}

export interface Usage {
  fetchedAt: number;
  planType?: string;
  windows: UsageWindow[];
}

export interface Account {
  /** Stable local identity. This is not the upstream ChatGPT account header. */
  id: string;
  /** Stable OAuth user subject, when supplied by OpenAI. */
  subject?: string;
  /** Workspace/account value sent as ChatGPT-Account-Id. */
  accountId?: string;
  email?: string;
  label?: string;
  refresh: string;
  access: string;
  expires: number;
  enterpriseUrl?: string;
  addedAt: number;
  lastUsedAt?: number;
  rateLimitUntilMs?: number;
  usage?: Usage;
}

export interface Store {
  version: 1;
  active?: string;
  accounts: Account[];
}
