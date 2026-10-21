import type { ToolResponse } from '../util/types.js';
import { runTracked, type CallState } from './invocation.js';
import { reloadAfterInvalidGrant } from './accounts.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function reauthError(email: string, note = ''): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: `Error: ${email}'s Google login expired or was revoked; run google_accounts_auth_start and sign in as that account.${note}`,
    }],
    isError: true,
  };
}

/**
 * Wraps a tool handler so an account signed in again by another process is picked up
 * without a restart. When a call fails with invalid_grant, the stale client is dropped and
 * the account file re-read; if it holds new tokens, the call is retried once. The retry is
 * only made when no request got past auth, so nothing can run twice.
 */
export function withReauthRetry(handler: Handler): Handler {
  return async (args) => {
    for (let attempt = 0; ; attempt++) {
      const state: CallState = { mayHaveReachedApi: false };
      let result: ToolResponse | undefined;
      let thrown: unknown;
      let threw = false;
      try {
        result = await runTracked(state, () => handler(args));
      } catch (err) {
        threw = true;
        thrown = err;
      }

      // Some handlers catch API errors and return them as text, so check what the client saw.
      const grant = state.invalidGrant;
      if (!grant || !(threw || result?.isError)) {
        if (threw) throw thrown;
        return result!;
      }

      const renewed = await reloadAfterInvalidGrant(grant.email, grant.client);
      if (renewed && attempt === 0 && !state.mayHaveReachedApi) continue;
      if (renewed && state.mayHaveReachedApi) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${grant.email}'s login was renewed, but part of this call may already have run, so it was not retried. Check the result before trying again.`,
          }],
          isError: true,
        };
      }
      return reauthError(grant.email, state.mayHaveReachedApi ? ' Part of this call may already have run.' : '');
    }
  };
}
