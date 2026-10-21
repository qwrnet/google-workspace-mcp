import { createServer, type Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';
import { createOAuth2Client } from './oauth.js';
import { getCallbackPort } from './config.js';
import type { ClientCredentials } from './clients.js';
import { getAccount, saveAccount } from './accounts.js';
import { buildAccountData } from '../util/token-helper.js';
import type { TokenFileData } from '../util/types.js';

let httpServer: HttpServer | null = null;
let expectedState: string | null = null;

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

/** Waits for the OAuth redirect; the code is exchanged with the same client that generated the auth URL. */
export function startCallbackServer(state: string, creds: ClientCredentials): Promise<TokenFileData> {
  return new Promise((resolve, reject) => {
    if (httpServer) {
      reject(new Error('Callback server already running'));
      return;
    }

    expectedState = state;
    const oauthClient = createOAuth2Client(creds);
    const port = getCallbackPort();
    let timeoutId: ReturnType<typeof setTimeout>;
    let settled = false;

    httpServer = createServer(async (req, res) => {
      if (settled) {
        res.writeHead(400);
        res.end('Authorization already completed.');
        return;
      }
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (!returnedState || returnedState !== expectedState) {
        res.writeHead(400);
        res.end('Invalid or missing state parameter.');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        const { tokens } = await oauthClient.getToken(code);
        oauthClient.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
        const { data: profile } = await oauth2.userinfo.get();

        if (!profile.email) {
          res.writeHead(400);
          res.end('Could not retrieve email from user profile.');
          settled = true;
          reject(new Error('Missing email in user profile'));
          return;
        }

        const existingAccount = await getAccount(profile.email).catch(() => null);
        const accountData = buildAccountData(tokens, profile, existingAccount, creds.name);

        if (!accountData.token.refresh_token) {
          res.writeHead(400);
          res.end('No refresh token available. Please revoke access and re-authorize.');
          settled = true;
          reject(new Error('No refresh token obtained'));
          return;
        }

        await saveAccount(accountData);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authenticated as ${escapeHtml(accountData.name)} (${escapeHtml(accountData.email)})</h2><p>You can close this tab.</p></body></html>`);

        settled = true;
        resolve(accountData);
      } catch (err) {
        console.error('OAuth authentication failed:', err);
        res.writeHead(500);
        res.end('Authentication failed. Please try again.');
        settled = true;
        reject(err);
      } finally {
        expectedState = null;
        clearTimeout(timeoutId);
        stopCallbackServer();
      }
    });

    httpServer.on('error', (err) => {
      clearTimeout(timeoutId);
      expectedState = null;
      httpServer = null;
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    httpServer.listen(port, '127.0.0.1');

    timeoutId = setTimeout(() => {
      if (httpServer && !settled) {
        settled = true;
        expectedState = null;
        stopCallbackServer();
        reject(new Error('OAuth callback timed out after 5 minutes'));
      }
    }, 5 * 60 * 1000);
  });
}

export function stopCallbackServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
