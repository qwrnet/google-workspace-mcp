import { readdir, readFile, writeFile, mkdir, unlink, chmod } from 'node:fs/promises';
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
  const next = prev.then(fn, fn).then(
    () => { if (writeLocks.get(email) === next) writeLocks.delete(email); },
    () => { if (writeLocks.get(email) === next) writeLocks.delete(email); },
  );
  writeLocks.set(email, next);
}

function getAccountsDir(): string {
  return process.env.GOOGLE_ACCOUNTS_DIR || DEFAULT_DIR;
}

const clientCache = new Map<string, OAuth2Client>();
const pendingClients = new Map<string, Promise<OAuth2Client>>();

export async function ensureAccountsDir(): Promise<void> {
  await mkdir(getAccountsDir(), { recursive: true });
}

export function emailToFilename(email: string): string {
  const safe = email.normalize('NFC').replace(/[^a-zA-Z0-9._@-]/g, '_').replace(/@/g, '_at_').replace(/\./g, '_');
  const result = safe.replace(/\.\./g, '_').slice(0, 200);
  if (!result) return 'unknown.json';
  return result + '.json';
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
  const toWrite = { ...data, token_file: fpath, last_used: new Date().toISOString() };
  await writeFile(fpath, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  await chmod(fpath, 0o600);
}

export async function deleteAccount(email: string): Promise<boolean> {
  try {
    const fpath = join(getAccountsDir(), emailToFilename(email));
    await unlink(fpath);
    clientCache.delete(email);
    pendingClients.delete(email);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns an authenticated OAuth2Client for the given account email.
 * If no email is provided, uses the most recently used account.
 * Clients are cached in memory and auto-persist refreshed tokens.
 * Concurrent calls for the same email await the same client creation.
 */
export async function getAuthClient(email?: string): Promise<OAuth2Client> {
  let resolvedEmail = email;

  if (!resolvedEmail) {
    const accounts = await listAccounts();
    if (accounts.length === 0) {
      throw new Error('No accounts configured. Use google_accounts_auth_start to add one.');
    }
    accounts.sort((a, b) => {
      const timeA = a.last_used ? new Date(a.last_used).getTime() : 0;
      const timeB = b.last_used ? new Date(b.last_used).getTime() : 0;
      return (Number.isFinite(timeB) ? timeB : 0) - (Number.isFinite(timeA) ? timeA : 0);
    });
    resolvedEmail = accounts[0].email;
  }

  if (clientCache.has(resolvedEmail)) {
    return clientCache.get(resolvedEmail)!;
  }

  // Deduplicate concurrent creation for the same email
  if (pendingClients.has(resolvedEmail)) {
    return pendingClients.get(resolvedEmail)!;
  }

  const emailForCreation = resolvedEmail;
  const promise = (async () => {
    const acct = await getAccount(emailForCreation);
    if (!acct) {
      throw new Error(`Account not found: ${emailForCreation}`);
    }

    const client = createOAuth2Client();
    client.setCredentials({
      access_token: acct.token.access_token,
      refresh_token: acct.token.refresh_token,
      expiry_date: acct.token.expiry ? new Date(acct.token.expiry).getTime() || undefined : undefined,
    });

    // Persist refreshed tokens to disk
    client.on('tokens', (tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }) => {
      withWriteLock(emailForCreation, async () => {
        try {
          const current = await getAccount(emailForCreation);
          if (!current) return;
          if (tokens.access_token) current.token.access_token = tokens.access_token;
          if (tokens.refresh_token) current.token.refresh_token = tokens.refresh_token;
          if (tokens.expiry_date !== undefined && tokens.expiry_date !== null) {
            const ts = Number(tokens.expiry_date);
            if (Number.isFinite(ts)) {
              current.token.expiry = new Date(ts).toISOString();
              current.token.expires_in = Math.max(0, Math.floor((ts - Date.now()) / 1000));
            }
          }
          await saveAccount(current);
        } catch (err) {
          console.error('Failed to persist refreshed tokens:', err);
        }
      });
    });

    clientCache.set(emailForCreation, client);
    await saveAccount(acct);

    return client;
  })();

  pendingClients.set(resolvedEmail, promise);
  try {
    return await promise;
  } finally {
    pendingClients.delete(resolvedEmail);
  }
}
