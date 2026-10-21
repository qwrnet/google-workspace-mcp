import type { TokenFileData } from './types.js';
import { DEFAULT_CLIENT_NAME } from '../auth/clients.js';

interface TokenResponse {
  access_token?: string | null;
  token_type?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
}

interface UserProfile {
  email?: string | null;
  name?: string | null;
  picture?: string | null;
}

/**
 * Build a TokenFileData from OAuth tokens and user profile.
 * Preserves existing refresh_token and expiry when new auth doesn't provide them.
 * Avoids persisting empty/invalid credential fields.
 */
export function buildAccountData(
  tokens: TokenResponse,
  profile: UserProfile,
  existingAccount: TokenFileData | null,
  clientName: string,
): TokenFileData {
  if (!tokens.access_token) {
    throw new Error('Missing access_token in token response');
  }
  // A refresh token is only valid for the client that issued it, so never carry one across clients.
  const sameClient = (existingAccount?.client ?? DEFAULT_CLIENT_NAME) === clientName;
  const refreshToken = tokens.refresh_token || (sameClient ? existingAccount?.token.refresh_token : '') || '';
  const expiryDate = typeof tokens.expiry_date === 'number' && !isNaN(tokens.expiry_date)
    ? tokens.expiry_date
    : null;

  return {
    email: profile.email || '',
    name: profile.name || '',
    picture: profile.picture || '',
    token: {
      access_token: tokens.access_token,
      token_type: tokens.token_type || 'Bearer',
      refresh_token: refreshToken,
      expiry: expiryDate ? new Date(expiryDate).toISOString() : (existingAccount?.token.expiry || ''),
      expires_in: expiryDate
        ? Math.max(0, Math.floor((expiryDate - Date.now()) / 1000))
        : (existingAccount?.token.expires_in || 0),
    },
    last_used: new Date().toISOString(),
    token_file: '',
    client: clientName,
  };
}
