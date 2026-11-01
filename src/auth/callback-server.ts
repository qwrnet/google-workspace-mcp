import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';
import { createOAuth2Client } from './oauth.js';
import { getCallbackPort } from './config.js';
import type { ClientCredentials } from './clients.js';
import { getAccount, saveAccount } from './accounts.js';
import { buildAccountData } from '../util/token-helper.js';
import type { OAuth2Client, TokenFileData } from '../util/types.js';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** One auth_start's wait for its redirect. A newer auth_start replaces it. */
interface PendingAuth {
  state: string;
  creds: ClientCredentials;
  oauthClient: OAuth2Client;
  timeoutId: ReturnType<typeof setTimeout>;
  /** A redirect with the right state and a code arrived; later redirects are refused. */
  claimed: boolean;
  /** The promise has resolved or rejected. */
  settled: boolean;
  resolve: (data: TokenFileData) => void;
  reject: (err: Error) => void;
}

let httpServer: HttpServer | null = null;
let pending: PendingAuth | null = null;
/** Callback saves run one at a time, so a save that started before a newer sign-in can't land after it. */
let saveQueue: Promise<unknown> = Promise.resolve();

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

/** First few characters of a state value, enough to tell two apart without revealing it. */
function statePrefix(state: string): string {
  return `${state.slice(0, 6)}…`;
}

function finish(session: PendingAuth): void {
  session.settled = true;
  clearTimeout(session.timeoutId);
  if (pending === session) {
    pending = null;
    stopCallbackServer();
  }
}

async function handleCallback(session: PendingAuth, code: string, res: ServerResponse): Promise<void> {
  const { oauthClient, creds } = session;
  try {
    const { tokens } = await oauthClient.getToken(code);
    oauthClient.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
    const { data: profile } = await oauth2.userinfo.get();

    if (!profile.email) {
      res.writeHead(400);
      res.end('Could not retrieve email from user profile.');
      session.reject(new Error('Missing email in user profile'));
      return;
    }

    // A newer auth_start or the timeout may have ended this session while we awaited Google. The check,
    // the read of the stored account and the merge all run inside the queue, so they see the previous
    // save's result and any newer sign-in's save is ordered after this one.
    const email = profile.email;
    const save = saveQueue.then(async (): Promise<TokenFileData | 'superseded' | 'no_refresh_token'> => {
      if (session.settled) return 'superseded';
      const existingAccount = await getAccount(email).catch(() => null);
      const data = buildAccountData(tokens, profile, existingAccount, creds.name);
      if (!data.token.refresh_token) return 'no_refresh_token';
      await saveAccount(data);
      return data;
    });
    saveQueue = save.catch(() => {});
    const accountData = await save;
    if (accountData === 'superseded') {
      res.writeHead(409);
      res.end('This sign-in was replaced by a newer google_accounts_auth_start or timed out. Nothing was saved.');
      return;
    }
    if (accountData === 'no_refresh_token') {
      res.writeHead(400);
      res.end('No refresh token available. Please revoke access and re-authorize.');
      session.reject(new Error('No refresh token obtained'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h2>Authenticated as ${escapeHtml(accountData.name)} (${escapeHtml(accountData.email)})</h2><p>You can close this tab.</p></body></html>`);
    session.resolve(accountData);
  } catch (err) {
    console.error('OAuth authentication failed:', err);
    res.writeHead(500);
    res.end('Authentication failed. Please try again.');
    session.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    finish(session);
  }
}

function ensureServer(port: number): void {
  if (httpServer) return;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const session = pending;
    if (!session || session.claimed || session.settled) {
      res.writeHead(400);
      res.end('No authorization is in progress. Run google_accounts_auth_start again.');
      return;
    }

    const returnedState = url.searchParams.get('state');
    if (!returnedState || returnedState !== session.state) {
      res.writeHead(400);
      res.end(
        `Invalid or missing state parameter. Expected a state beginning "${statePrefix(session.state)}" ` +
        `but received ${returnedState ? `"${statePrefix(returnedState)}"` : 'none'}. ` +
        'Open the URL from the most recent google_accounts_auth_start.',
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      res.end('Missing authorization code');
      return;
    }

    // Claim the session so a repeated redirect can't exchange the code twice; the timeout still applies.
    session.claimed = true;
    await handleCallback(session, code, res);
  });

  server.on('error', (err) => {
    if (httpServer === server) httpServer = null;
    const session = pending;
    if (session) {
      pending = null;
      clearTimeout(session.timeoutId);
      session.settled = true;
      session.reject(new Error(`Failed to start callback server: ${err.message}`));
    }
  });

  server.listen(port, '127.0.0.1');
  httpServer = server;
}

/**
 * Waits for the OAuth redirect; the code is exchanged with the same client that generated the auth URL.
 * Calling it again while a redirect is pending replaces that wait: only the newest state and client are
 * accepted, and the earlier promise rejects.
 */
export function startCallbackServer(state: string, creds: ClientCredentials): Promise<TokenFileData> {
  return new Promise((resolve, reject) => {
    let port: number;
    try {
      port = getCallbackPort();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const previous = pending;
    if (previous) {
      clearTimeout(previous.timeoutId);
      if (!previous.settled) {
        previous.settled = true;
        previous.reject(new Error('Superseded by a newer google_accounts_auth_start'));
      }
    }

    const session: PendingAuth = {
      state,
      creds,
      oauthClient: createOAuth2Client(creds),
      timeoutId: setTimeout(() => {
        if (!session.settled) {
          session.reject(new Error('OAuth callback timed out after 5 minutes'));
          finish(session);
        }
      }, CALLBACK_TIMEOUT_MS),
      claimed: false,
      settled: false,
      resolve,
      reject,
    };
    session.timeoutId.unref?.();
    pending = session;

    ensureServer(port);
  });
}

export function stopCallbackServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
