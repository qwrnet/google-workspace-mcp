import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from '../util/types.js';
import { getRedirectUri } from './config.js';
import type { ClientCredentials } from './clients.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly',
];

export function createOAuth2Client(creds: ClientCredentials): OAuth2Client {
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, getRedirectUri());
}

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export function getAuthUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}
