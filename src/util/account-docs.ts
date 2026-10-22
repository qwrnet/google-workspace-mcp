/** Shared description for every tool's account_email parameter, so agents see one consistent rule. */
export const ACCOUNT_EMAIL_DESCRIPTION =
  'Email of the Google account to use (see google_accounts_list). Pass it whenever more than one account is configured. ' +
  'If omitted, the server uses GOOGLE_DEFAULT_ACCOUNT, otherwise the most recently used account, which may not be the one intended.';

/** MCP server instructions: how agents should work with multiple accounts. */
export const SERVER_INSTRUCTIONS = `Google Workspace tools for one or more Google accounts.

Accounts:
- Call google_accounts_list first to see which accounts are configured. Each entry has the email and the OAuth client that issued it.
- When more than one account is configured, pass account_email on every call. Without it the server falls back to GOOGLE_DEFAULT_ACCOUNT, then to the most recently used account, so a call can silently act as the wrong account. If the user has not said which account to use and it is ambiguous, ask.
- Use the same account_email for every call in one task. IDs (files, messages, events, spreadsheets) belong to the account that returned them and are generally not visible to another account.

Adding an account:
- google_accounts_auth_start returns a URL for the user to open; once they authorize, the account is saved automatically.
- If the server has several OAuth clients configured, pass client to auth_start. Accounts from a Workspace org whose consent screen is Internal must use that org's client; the wrong one fails with "Error 403: org_internal".
- If the automatic callback does not complete, the user can paste the authorization code into google_accounts_auth_callback.

If a call fails because the account needs to be signed in again, run google_accounts_auth_start for that account (with the same client shown by google_accounts_list).`;
