import { readdir, readFile, writeFile, mkdir, unlink, chmod, stat, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { OAuth2Client } from '../util/types.js';
import { createOAuth2Client } from './oauth.js';
import { instrumentClient } from './invocation.js';
import { resolveClient } from './clients.js';
import { getAccountsDir } from './config.js';
import type { TokenFileData } from '../util/types.js';

// Per-account write lock to prevent race conditions in token refresh persistence
const writeLocks = new Map<string, Promise<void>>();
function withWriteLock(email: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeLocks.get(email) || Promise.resolve();
  const next = prev.then(fn, fn).then(
    () => { if (writeLocks.get(email) === next) writeLocks.delete(email); },
    () => { if (writeLocks.get(email) === next) writeLocks.delete(email); },
  );
  writeLocks.set(email, next);
  return next;
}

const clientCache = new Map<string, OAuth2Client>();
// mtime of the account file when we last confirmed the cached client matches it. Left unset
// at creation, so the first reuse compares tokens even if the file changed while building.
const clientFileMtime = new Map<string, number>();
const lastTouched = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Record use of an account so the "most recently used" fallback follows what is
 * actually being called. Throttled and fire-and-forget to avoid a disk write per call.
 */
function touchAccount(email: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(email) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(email, now);
  withWriteLock(email, async () => {
    try {
      const current = await getAccount(email);
      if (current) await saveAccount(current);
    } catch (err) {
      console.error('Failed to update last_used:', err);
    }
  });
}
const pendingClients = new Map<string, Promise<OAuth2Client>>();

function accountPath(email: string): string {
  return join(getAccountsDir(), emailToFilename(email));
}

async function fileMtime(email: string): Promise<number | null> {
  try {
    return (await stat(accountPath(email))).mtimeMs;
  } catch {
    return null;
  }
}

/** Drop the cached client for an account, but only if it is still the one given (when given). */
function evictClient(email: string, client?: OAuth2Client): void {
  if (client && clientCache.get(email) !== client) return;
  clientCache.delete(email);
  clientFileMtime.delete(email);
  lastTouched.delete(email);
}

/**
 * True when another process re-authenticated the account since this client was built.
 * Our own refreshes rewrite the file too (new mtime), but never change the refresh token.
 */
async function isStale(email: string, client: OAuth2Client): Promise<boolean> {
  const mtime = await fileMtime(email);
  if (mtime === null) return true;
  if (mtime === clientFileMtime.get(email)) return false;
  const acct = await getAccount(email);
  if (!acct) return false; // unreadable right now; keep the client and look again next call
  if (acct.token.refresh_token !== client.credentials.refresh_token) return true;
  clientFileMtime.set(email, mtime);
  return false;
}

/**
 * Called after a request failed with invalid_grant. Evicts the client that failed and
 * re-reads the account file. Returns true when the file holds different tokens (the account
 * was signed in again, likely by another process), so the call is worth one retry.
 */
export async function reloadAfterInvalidGrant(email: string, failed: OAuth2Client): Promise<boolean> {
  evictClient(email, failed);
  const acct = await getAccount(email);
  if (!acct) return false;
  return acct.token.refresh_token !== failed.credentials.refresh_token
    || acct.token.access_token !== failed.credentials.access_token;
}

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
      const parsed = JSON.parse(raw);
      // The directory also holds clients.json; only accept files shaped like an account.
      if (typeof parsed?.email !== 'string' || typeof parsed?.token !== 'object' || parsed.token === null) continue;
      accounts.push(parsed);
    } catch {
      // skip corrupt files
    }
  }
  return accounts;
}

export async function getAccount(email: string): Promise<TokenFileData | null> {
  try {
    return JSON.parse(await readFile(accountPath(email), 'utf-8'));
  } catch {
    return null;
  }
}

export async function saveAccount(data: TokenFileData): Promise<void> {
  await ensureAccountsDir();
  const fpath = join(getAccountsDir(), emailToFilename(data.email));
  const toWrite = { ...data, token_file: fpath, last_used: new Date().toISOString() };
  // Write then rename, so readers in this or another process never see a half-written file
  const tmp = `${fpath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, fpath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function deleteAccount(email: string): Promise<boolean> {
  try {
    const fpath = join(getAccountsDir(), emailToFilename(email));
    await unlink(fpath);
    evictClient(email);
    pendingClients.delete(email);
    lastTouched.delete(email);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns an authenticated OAuth2Client for the given account email.
 * If no email is provided, uses GOOGLE_DEFAULT_ACCOUNT when set, otherwise the most
 * recently used account. Each account is refreshed with the OAuth client that issued it.
 * Clients are cached in memory and auto-persist refreshed tokens.
 * Concurrent calls for the same email await the same client creation.
 */
export async function getAuthClient(email?: string): Promise<OAuth2Client> {
  let resolvedEmail = email || process.env.GOOGLE_DEFAULT_ACCOUNT || undefined;

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

  const cached = clientCache.get(resolvedEmail);
  if (cached) {
    if (!(await isStale(resolvedEmail, cached))) {
      touchAccount(resolvedEmail);
      return cached;
    }
    evictClient(resolvedEmail, cached);
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

    const client = createOAuth2Client(await resolveClient(acct.client));
    client.setCredentials({
      access_token: acct.token.access_token,
      refresh_token: acct.token.refresh_token,
      expiry_date: acct.token.expiry ? new Date(acct.token.expiry).getTime() || undefined : undefined,
    });

    instrumentClient(client, emailForCreation);

    // Persist refreshed tokens to disk. A client that was replaced after a re-auth keeps
    // this listener, so it only writes while the file still holds its refresh token.
    let ownRefreshToken = acct.token.refresh_token;
    client.on('tokens', (event: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }) => {
      const tokens = { ...event }; // the library mutates the event object after emitting
      withWriteLock(emailForCreation, async () => {
        try {
          const current = await getAccount(emailForCreation);
          if (!current) return;
          if (current.token.refresh_token !== ownRefreshToken) return; // signed in again elsewhere
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
          ownRefreshToken = current.token.refresh_token;
        } catch (err) {
          console.error('Failed to persist refreshed tokens:', err);
        }
      });
    });

    clientCache.set(emailForCreation, client);
    lastTouched.set(emailForCreation, Date.now());
    // Bump last_used from the file as it is now, so a re-auth written meanwhile is kept
    await withWriteLock(emailForCreation, async () => {
      const current = await getAccount(emailForCreation);
      if (current) await saveAccount(current);
    });

    return client;
  })();

  pendingClients.set(resolvedEmail, promise);
  try {
    return await promise;
  } finally {
    pendingClients.delete(resolvedEmail);
  }
}
