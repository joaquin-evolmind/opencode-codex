import type { RefreshTokenResponse } from './types.js';

interface Claims {
  sub?: string;
  email?: string;
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    user_email?: string;
  };
  'https://api.openai.com/profile'?: {
    email?: string;
  };
}

function parse(token: string | undefined): Claims | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  } catch {
    return undefined;
  }
}

function fromClaims(c: Claims | undefined): {
  subject?: string;
  accountId?: string;
  email?: string;
} {
  if (!c) return {};
  const accountId =
    c.chatgpt_account_id ||
    c['https://api.openai.com/auth']?.chatgpt_account_id ||
    c.organizations?.[0]?.id;
  const email =
    c.email ||
    c['https://api.openai.com/profile']?.email ||
    c['https://api.openai.com/auth']?.user_email;
  return { subject: c.sub, accountId, email };
}

export function identify(tokens: RefreshTokenResponse): {
  subject?: string;
  accountId?: string;
  email?: string;
} {
  const fromId = fromClaims(parse(tokens.id_token));
  const fromAccess = fromClaims(parse(tokens.access_token));
  return {
    subject: fromId.subject ?? fromAccess.subject,
    accountId: fromId.accountId ?? fromAccess.accountId,
    email: fromId.email ?? fromAccess.email,
  };
}

export function localId(subject: string, accountId?: string): string {
  const encodedSubject = encodeURIComponent(subject);
  return accountId
    ? `oauth-v2:${encodedSubject}:${encodeURIComponent(accountId)}`
    : `oauth-sub-v1:${encodedSubject}`;
}
