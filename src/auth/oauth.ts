import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from '../util/types.js';

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

export const REDIRECT_URI = 'http://127.0.0.1:8080/oauth/callback';

export function createOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables must be set');
  }
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
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
