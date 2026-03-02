import { createServer, type Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';
import { createOAuth2Client } from './oauth.js';
import { getAccount, saveAccount } from './accounts.js';
import type { TokenFileData } from '../util/types.js';

let httpServer: HttpServer | null = null;

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

export function startCallbackServer(): Promise<TokenFileData> {
  return new Promise((resolve, reject) => {
    if (httpServer) {
      reject(new Error('Callback server already running'));
      return;
    }

    const oauthClient = createOAuth2Client();
    let timeoutId: ReturnType<typeof setTimeout>;

    httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost:8080');
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end('Not found');
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
          reject(new Error('Missing email in user profile'));
          return;
        }

        // Preserve existing refresh_token if the new auth didn't return one
        const existingAccount = await getAccount(profile.email).catch(() => null);
        const refreshToken = tokens.refresh_token || existingAccount?.token.refresh_token || '';

        const accountData: TokenFileData = {
          email: profile.email,
          name: profile.name || '',
          picture: profile.picture || '',
          token: {
            access_token: tokens.access_token || '',
            token_type: tokens.token_type || 'Bearer',
            refresh_token: refreshToken,
            expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '',
            expires_in: typeof tokens.expiry_date === 'number'
              ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
              : 3600,
          },
          last_used: new Date().toISOString(),
          token_file: '',
        };

        await saveAccount(accountData);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authenticated as ${escapeHtml(accountData.name)} (${escapeHtml(accountData.email)})</h2><p>You can close this tab.</p></body></html>`);

        resolve(accountData);
      } catch (err) {
        console.error('OAuth authentication failed:', err);
        res.writeHead(500);
        res.end('Authentication failed. Please try again.');
        reject(err);
      } finally {
        clearTimeout(timeoutId);
        stopCallbackServer();
      }
    });

    httpServer.on('error', (err) => {
      clearTimeout(timeoutId);
      httpServer = null;
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    httpServer.listen(8080);

    timeoutId = setTimeout(() => {
      if (httpServer) {
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
