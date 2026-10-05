/**
 * Read non-secret identity claims (email, ChatGPT account ID) from an OAuth
 * access token for display and request headers. Tokens are never logged.
 */
interface Claims {
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

export function identify(accessToken: string | undefined): {
  accountId?: string;
  email?: string;
} {
  const c = parse(accessToken);
  if (!c) return {};
  const accountId =
    c.chatgpt_account_id ||
    c['https://api.openai.com/auth']?.chatgpt_account_id ||
    c.organizations?.[0]?.id;
  const email =
    c.email ||
    c['https://api.openai.com/profile']?.email ||
    c['https://api.openai.com/auth']?.user_email;
  return { accountId, email };
}
