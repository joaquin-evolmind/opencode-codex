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

/** A native OpenCode ChatGPT credential, as shown to the user. No secrets. */
export interface CodexAccount {
  /** OpenCode credential ID. */
  id: string;
  label: string;
  /** True for OpenCode's active credential: the explicit manual selection. */
  active: boolean;
  email?: string;
  accountId?: string;
  usage?: Usage;
}
