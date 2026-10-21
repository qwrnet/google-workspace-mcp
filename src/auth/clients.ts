import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAccountsDir } from './config.js';

export interface ClientCredentials {
  name: string;
  client_id: string;
  client_secret: string;
}

export const DEFAULT_CLIENT_NAME = 'default';

function getClientsFile(): string {
  return process.env.GOOGLE_OAUTH_CLIENTS_FILE || join(getAccountsDir(), 'clients.json');
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

async function readJson(path: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    // Deliberately omit file contents from the message — they may hold secrets.
    const reason = err instanceof SyntaxError ? 'invalid JSON' : (err as NodeJS.ErrnoException).code || 'unreadable';
    throw new Error(`Failed to read ${what} (${path}): ${reason}`);
  }
}

function pickCredentials(name: string, obj: unknown, where: string): ClientCredentials {
  const o = obj as Record<string, unknown> | null;
  const id = o?.client_id;
  const secret = o?.client_secret;
  if (typeof id !== 'string' || !id || typeof secret !== 'string' || !secret) {
    throw new Error(`OAuth client "${name}" in ${where} needs client_id and client_secret`);
  }
  return { name, client_id: id, client_secret: secret };
}

/**
 * Registry file format — a map of client name to either inline credentials or a path
 * to a client_secret.json downloaded from Google Cloud Console:
 *
 *   {
 *     "personal": { "client_id": "...", "client_secret": "..." },
 *     "work": { "file": "~/Downloads/client_secret_work.json" }
 *   }
 */
async function loadFileClients(): Promise<Map<string, ClientCredentials>> {
  const path = getClientsFile();
  const clients = new Map<string, ClientCredentials>();

  let st;
  try {
    st = await stat(path);
  } catch {
    return clients; // No registry file — env-only setup.
  }

  const raw = await readJson(path, 'OAuth clients file');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`OAuth clients file (${path}) must be a JSON object of name -> client`);
  }

  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    console.error(`Warning: ${path} is readable by other users; run chmod 600 on it.`);
  }

  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    const file = (entry as Record<string, unknown> | null)?.file;
    if (typeof file === 'string') {
      const downloaded = (await readJson(expandHome(file), `client file for "${name}"`)) as Record<string, unknown>;
      // Google's download wraps credentials in "installed" or "web".
      clients.set(name, pickCredentials(name, downloaded.installed ?? downloaded.web ?? downloaded, expandHome(file)));
    } else {
      clients.set(name, pickCredentials(name, entry, path));
    }
  }
  return clients;
}

/** All configured clients. GOOGLE_CLIENT_ID/SECRET act as an implicit "default" unless the file defines one. */
export async function loadClients(): Promise<Map<string, ClientCredentials>> {
  const clients = await loadFileClients();
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (id && secret && !clients.has(DEFAULT_CLIENT_NAME)) {
    clients.set(DEFAULT_CLIENT_NAME, { name: DEFAULT_CLIENT_NAME, client_id: id, client_secret: secret });
  }
  return clients;
}

/**
 * Resolve a client by name. With no name: "default" if configured, otherwise the
 * only configured client. Accounts saved before named clients existed have no name
 * and therefore resolve the same way.
 */
export async function resolveClient(name?: string): Promise<ClientCredentials> {
  const clients = await loadClients();
  if (clients.size === 0) {
    throw new Error(
      'No OAuth client configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or add clients to ' + getClientsFile(),
    );
  }

  if (name) {
    const found = clients.get(name);
    if (!found) {
      throw new Error(`Unknown OAuth client "${name}". Configured clients: ${[...clients.keys()].join(', ')}`);
    }
    return found;
  }

  const fallback = clients.get(DEFAULT_CLIENT_NAME) ?? (clients.size === 1 ? [...clients.values()][0] : undefined);
  if (!fallback) {
    throw new Error(`Multiple OAuth clients configured; specify one of: ${[...clients.keys()].join(', ')}`);
  }
  return fallback;
}
