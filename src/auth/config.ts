import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DIR = join(homedir(), '.google-mcp-accounts');
const DEFAULT_CALLBACK_PORT = 9876;

export function getAccountsDir(): string {
  return process.env.GOOGLE_ACCOUNTS_DIR || DEFAULT_DIR;
}

/** Loopback port the OAuth callback server listens on (GOOGLE_OAUTH_PORT, default 9876). */
export function getCallbackPort(): number {
  const raw = process.env.GOOGLE_OAUTH_PORT;
  if (!raw) return DEFAULT_CALLBACK_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid GOOGLE_OAUTH_PORT: ${raw}`);
  }
  return port;
}

export function getRedirectUri(): string {
  return `http://127.0.0.1:${getCallbackPort()}/oauth/callback`;
}
