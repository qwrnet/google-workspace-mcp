import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OAuth2Client } from '../util/types.js';
import { createOAuth2Client } from './oauth.js';
import type { TokenFileData } from '../util/types.js';

const DEFAULT_DIR = join(homedir(), '.google-mcp-accounts');

// Per-account write lock to prevent race conditions in token refresh persistence
const writeLocks = new Map<string, Promise<void>>();
function withWriteLock(email: string, fn: () => Promise<void>): void {
  const prev = writeLocks.get(email) || Promise.resolve();
  writeLocks.set(email, prev.then(fn, fn));
}

function getAccountsDir(): string {
  return process.env.GOOGLE_ACCOUNTS_DIR || DEFAULT_DIR;
}

const clientCache = new Map<string, OAuth2Client>();

export async function ensureAccountsDir(): Promise<void> {
  await mkdir(getAccountsDir(), { recursive: true });
}

export function emailToFilename(email: string): string {
  return email.replace(/@/g, '_at_').replace(/\./g, '_') + '.json';
}

export async function listAccounts(): Promise<TokenFileData[]> {
  await ensureAccountsDir();
  const dir = getAccountsDir();
  const files = await readdir(dir);
  const accounts: TokenFileData[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf-8');
      accounts.push(JSON.parse(raw));
    } catch {
      // skip corrupt files
    }
  }
  return accounts;
}

export async function getAccount(email: string): Promise<TokenFileData | null> {
  try {
    const fpath = join(getAccountsDir(), emailToFilename(email));
    return JSON.parse(await readFile(fpath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function saveAccount(data: TokenFileData): Promise<void> {
  await ensureAccountsDir();
  const fpath = join(getAccountsDir(), emailToFilename(data.email));
  data.token_file = fpath;
  data.last_used = new Date().toISOString();
  await writeFile(fpath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function deleteAccount(email: string): Promise<boolean> {
  try {
    const fpath = join(getAccountsDir(), emailToFilename(email));
    await unlink(fpath);
    clientCache.delete(email);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns an authenticated OAuth2Client for the given account email.
 * If no email is provided, uses the most recently used account.
 * Clients are cached in memory and auto-persist refreshed tokens.
 */
export async function getAuthClient(email?: string): Promise<OAuth2Client> {
  let resolvedEmail = email;

  if (!resolvedEmail) {
    const accounts = await listAccounts();
    if (accounts.length === 0) {
      throw new Error('No accounts configured. Use google_accounts_auth_start to add one.');
    }
    accounts.sort((a, b) => new Date(b.last_used).getTime() - new Date(a.last_used).getTime());
    resolvedEmail = accounts[0].email;
  }

  if (clientCache.has(resolvedEmail)) {
    const acct = await getAccount(resolvedEmail);
    if (acct) {
      acct.last_used = new Date().toISOString();
      await saveAccount(acct);
    }
    return clientCache.get(resolvedEmail)!;
  }

  const acct = await getAccount(resolvedEmail);
  if (!acct) {
    throw new Error(`Account not found: ${resolvedEmail}`);
  }

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: acct.token.access_token,
    refresh_token: acct.token.refresh_token,
    expiry_date: new Date(acct.token.expiry).getTime(),
  });

  // Persist refreshed tokens to disk
  const emailForListener = resolvedEmail;
  client.on('tokens', (tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }) => {
    withWriteLock(emailForListener, async () => {
      try {
        const current = await getAccount(emailForListener);
        if (!current) return;
        if (tokens.access_token) current.token.access_token = tokens.access_token;
        if (tokens.refresh_token) current.token.refresh_token = tokens.refresh_token;
        if (tokens.expiry_date) {
          current.token.expiry = new Date(tokens.expiry_date).toISOString();
          current.token.expires_in = Math.floor((tokens.expiry_date - Date.now()) / 1000);
        }
        await saveAccount(current);
      } catch (err) {
        console.error('Failed to persist refreshed tokens:', err);
      }
    });
  });

  clientCache.set(resolvedEmail, client);

  acct.last_used = new Date().toISOString();
  await saveAccount(acct);

  return client;
}
