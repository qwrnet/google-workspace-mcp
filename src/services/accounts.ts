import { google } from 'googleapis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse, GetAuthClient } from '../util/types.js';
import { createOAuth2Client, getAuthUrl, generateState } from '../auth/oauth.js';
import { listAccounts, getAccount, saveAccount, deleteAccount } from '../auth/accounts.js';
import { startCallbackServer } from '../auth/callback-server.js';
import { buildAccountData } from '../util/token-helper.js';

function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

function json(data: unknown): ToolResponse {
  return ok(JSON.stringify(data, null, 2));
}

function error(msg: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

export const tools: Tool[] = [
  {
    name: 'google_accounts_list',
    description: 'List all configured Google accounts',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'google_accounts_auth_start',
    description:
      'Start the OAuth2 authentication flow. Returns a URL the user must visit to authorize access.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'google_accounts_auth_callback',
    description:
      'Manually complete OAuth2 authentication by providing the authorization code. Alternative to the automatic callback server.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'The authorization code from the OAuth2 callback',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'google_accounts_remove',
    description: 'Remove a configured Google account',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_email: {
          type: 'string',
          description: 'Email address of the account to remove',
        },
      },
      required: ['account_email'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  _getAuth: GetAuthClient,
): void {
  handleCall('google_accounts_list', async () => {
    const accounts = await listAccounts();
    return json(
      accounts.map((a) => ({
        email: a.email,
        name: a.name,
        last_used: a.last_used,
      })),
    );
  });

  handleCall('google_accounts_auth_start', async () => {
    const client = createOAuth2Client();
    const state = generateState();
    const url = getAuthUrl(client, state);

    // Start callback server in the background — don't await
    startCallbackServer(state).catch(() => {
      // Callback server errors are non-fatal; user can use auth_callback manually
    });

    return ok(
      `Visit this URL to authenticate:\n\n${url}\n\nThe callback server is listening. After you authorize, the account will be saved automatically. Alternatively, copy the authorization code and use google_accounts_auth_callback.`,
    );
  });

  handleCall('google_accounts_auth_callback', async (args) => {
    const code = args.code as string | undefined;
    if (!code) {
      return error('Missing required parameter: code');
    }

    const oauthClient = createOAuth2Client();
    let tokens;
    try {
      ({ tokens } = await oauthClient.getToken(code));
    } catch (err) {
      return error(`Token exchange failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    oauthClient.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
    let profile;
    try {
      const { data } = await oauth2.userinfo.get();
      profile = data;
    } catch (err) {
      return error(`Failed to retrieve user profile: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    if (!profile.email) {
      return error('Could not retrieve email from user profile. Ensure the email scope is authorized.');
    }

    const existingAccount = await getAccount(profile.email).catch(() => null);
    const accountData = buildAccountData(tokens, profile, existingAccount);

    if (!accountData.token.refresh_token) {
      return error('No refresh token obtained. Try revoking access at https://myaccount.google.com/permissions and re-authorizing.');
    }

    await saveAccount(accountData);

    return json({
      email: accountData.email,
      name: accountData.name,
      message: 'Account authenticated and saved successfully',
    });
  });

  handleCall('google_accounts_remove', async (args) => {
    const email = args.account_email as string | undefined;
    if (!email) {
      return error('Missing required parameter: account_email');
    }

    const deleted = await deleteAccount(email);
    if (!deleted) {
      return error(`Account not found: ${email}`);
    }

    return ok(`Account ${email} removed successfully`);
  });
}
