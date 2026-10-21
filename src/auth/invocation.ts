import { AsyncLocalStorage } from 'node:async_hooks';
import type { OAuth2Client } from '../util/types.js';

/** What the Google clients saw during one tool call. */
export interface CallState {
  /** A request got past auth (or failed for another reason), so the API may have acted on it. */
  mayHaveReachedApi: boolean;
  /** Set when a request failed with invalid_grant before it was sent. */
  invalidGrant?: { email: string; client: OAuth2Client };
}

const callState = new AsyncLocalStorage<CallState>();

export function runTracked<T>(state: CallState, fn: () => Promise<T>): Promise<T> {
  return callState.run(state, fn);
}

/** True for the error Google returns when a refresh token is expired or revoked. */
export function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } } | null;
  return e?.response?.data?.error === 'invalid_grant' || e?.message === 'invalid_grant';
}

/**
 * Wrap client.request so the tool call that made the request can tell whether it failed
 * with invalid_grant before anything was sent. googleapis sends every API call through it.
 */
export function instrumentClient(client: OAuth2Client, email: string): void {
  const original = client.request.bind(client) as (opts: unknown, callback?: unknown) => unknown;
  (client as { request: unknown }).request = (opts: unknown, callback?: unknown) => {
    const state = callState.getStore();
    if (callback || !state) return original(opts, callback);
    return (original(opts) as Promise<unknown>).then(
      (res) => {
        state.mayHaveReachedApi = true;
        return res;
      },
      (err) => {
        // invalid_grant comes from the token refresh, or from a 401 that triggered one; the
        // API never accepted the request. Anything else may have been acted on.
        if (isInvalidGrant(err)) state.invalidGrant ??= { email, client };
        else state.mayHaveReachedApi = true;
        throw err;
      },
    );
  };
}
