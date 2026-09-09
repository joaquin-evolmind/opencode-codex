import { OAUTH_CLIENT_ID, OAUTH_ISSUER, OAUTH_SCOPE } from '../config.js';
import type { PkceCodes } from './pkce.js';
import type { RefreshTokenResponse, TokenResponse } from './types.js';

export function authorizeUrl(
  redirectUri: string,
  codes: PkceCodes,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: codes.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'opencode',
  });
  return `${OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

export async function exchange(
  code: string,
  redirectUri: string,
  codes: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codes.verifier,
    }).toString(),
  });
  if (!response.ok)
    throw new Error(`Token exchange failed: ${response.status}`);
  return response.json() as Promise<TokenResponse>;
}

export async function refresh(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<RefreshTokenResponse> {
  const response = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  return response.json() as Promise<RefreshTokenResponse>;
}
