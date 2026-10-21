# Google Workspace MCP Server

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) server that provides 41 tools for interacting with Google Workspace APIs: Drive, Sheets, Docs, Gmail, Calendar, Slides, and Groups.

## Features

- **41 tools** across 8 Google Workspace services
- **Auto-refreshing tokens** — uses the `googleapis` npm client which handles token refresh transparently
- **Multi-account support** — authenticate multiple Google accounts, switch between them per-request
- **Multiple OAuth clients** — accounts from different Workspace orgs can live in one server (see [Multiple OAuth clients](#multiple-oauth-clients))
- **Backward-compatible** token storage at `~/.google-mcp-accounts/`

## Prerequisites

- Node.js >= 20
- pnpm
- A Google Cloud project with an OAuth 2.0 **Web application** client

## Setup

### 1. Google Cloud Console

1. Create a project (or use an existing one) at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the following APIs:
   - Google Drive API
   - Google Sheets API
   - Google Docs API
   - Gmail API
   - Google Calendar API
   - Google Slides API
   - Cloud Identity API
3. Go to **APIs & Services > Credentials**
4. Create an **OAuth 2.0 Client ID** with type **Web application**
5. Add `http://127.0.0.1:9876/oauth/callback` as an **Authorized redirect URI**
6. Note the **Client ID** and **Client Secret**

### 2. Build

```sh
pnpm install
pnpm build
```

### 3. Configure Claude Code

Add to your `~/.claude.json` under `mcpServers`:

```json
{
  "google-workspace": {
    "type": "stdio",
    "command": "pnpm",
    "args": ["--silent", "--prefix", "/path/to/google-workspace-mcp", "start"],
    "env": {
      "GOOGLE_CLIENT_ID": "<your-client-id>",
      "GOOGLE_CLIENT_SECRET": "<your-client-secret>",
      "GOOGLE_ACCOUNTS_DIR": "/home/<user>/.google-mcp-accounts"
    }
  }
}
```

### 4. Authenticate

After restarting Claude Code, use the `google_accounts_auth_start` tool to begin the OAuth flow. Visit the returned URL in your browser to authorize access.

## Multiple OAuth clients

An OAuth client whose consent screen is **Internal** only accepts users from its own Google Workspace org (others get `Error 403: org_internal`). To use accounts from different orgs in one server, register several named clients in `clients.json` inside the accounts directory (or the file named by `GOOGLE_OAUTH_CLIENTS_FILE`):

```json
{
  "work": { "client_id": "...", "client_secret": "..." },
  "personal": { "file": "~/Downloads/client_secret_personal.json" }
}
```

Each entry is either inline credentials or a `file` pointing at the JSON downloaded from Google Cloud Console. Keep the file `chmod 600`; the server warns if it is readable by others.

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` still work and act as a client named `default`, so existing setups need no changes. A `default` entry in `clients.json` takes precedence over the env vars.
- Add an account with `google_accounts_auth_start` and `client: "personal"`. The account records which client issued it and is always refreshed with that client. Accounts saved before this feature are treated as `default`.
- With no `client` argument, `default` is used, or the only configured client if there is just one. If several are configured and none is named `default`, you must name one.
- Refresh tokens are only valid for the client that issued them, so re-authorizing an existing account with a different client requires a fresh consent rather than reusing the old token.

## Tools

### Accounts (4)

| Tool | Description |
|------|-------------|
| `google_accounts_list` | List all configured Google accounts and the OAuth client each uses |
| `google_accounts_auth_start` | Start OAuth2 authentication flow (optional `client`) |
| `google_accounts_auth_callback` | Complete auth with an authorization code (optional `client`) |
| `google_accounts_remove` | Remove a configured account |

### Drive (16)

| Tool | Description |
|------|-------------|
| `google_drive_list` | List files and folders |
| `google_drive_get` | Get file metadata |
| `google_drive_read` | Read file content (exports Workspace files to text) |
| `google_drive_create_file` | Create a new file with content |
| `google_drive_create_folder` | Create a new folder |
| `google_drive_update` | Update file metadata |
| `google_drive_upload` | Replace file content |
| `google_drive_delete` | Trash or permanently delete a file |
| `google_drive_copy` | Copy a file |
| `google_drive_move` | Move a file to a different folder |
| `google_drive_search` | Full-text search across Drive |
| `google_drive_share` | Share a file with a user |
| `google_drive_unshare` | Remove a sharing permission |
| `google_drive_get_permissions` | List file permissions |
| `google_drive_export` | Export to a specific format (PDF, CSV, etc.) |
| `google_drive_get_comments` | Get comments on a file |

### Sheets (5)

| Tool | Description |
|------|-------------|
| `google_sheets_create` | Create a new spreadsheet |
| `google_sheets_get_metadata` | Get spreadsheet metadata and sheet list |
| `google_sheets_read` | Read cell values from a range |
| `google_sheets_write` | Write values to a range |
| `google_sheets_append` | Append rows to a sheet |

### Docs (3)

| Tool | Description |
|------|-------------|
| `google_docs_create` | Create a new document |
| `google_docs_read` | Read document content as text |
| `google_docs_write` | Write to a document via batchUpdate |

### Gmail (3)

| Tool | Description |
|------|-------------|
| `google_gmail_list` | List/search messages |
| `google_gmail_read` | Read a message (headers + body) |
| `google_gmail_send` | Send an email |

### Calendar (3)

| Tool | Description |
|------|-------------|
| `google_calendar_list_events` | List events with time range filter |
| `google_calendar_create_event` | Create an event with attendees |
| `google_calendar_update_event` | Update an existing event |
| `google_calendar_delete_event` | Delete an event (reports its title and start; readable not-found and permission errors; guests not emailed unless `send_updates` says so) |

### Slides (4)

| Tool | Description |
|------|-------------|
| `google_slides_get` | Get presentation metadata and slides |
| `google_slides_create` | Create a new presentation |
| `google_slides_add_slide` | Add a slide with a layout |
| `google_slides_update` | Batch update a presentation |

### Groups (3)

| Tool | Description |
|------|-------------|
| `google_groups_list` | List groups (requires Workspace account) |
| `google_groups_get_members` | Get members of a group |
| `google_groups_add_member` | Add a member to a group |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | One of these or `clients.json` | OAuth 2.0 client ID (the `default` client) |
| `GOOGLE_CLIENT_SECRET` | One of these or `clients.json` | OAuth 2.0 client secret (the `default` client) |
| `GOOGLE_OAUTH_CLIENTS_FILE` | No | Path to the named-clients file (default: `<accounts dir>/clients.json`) |
| `GOOGLE_DEFAULT_ACCOUNT` | No | Account used when a tool call omits `account_email` (default: most recently used) |
| `GOOGLE_OAUTH_PORT` | No | Loopback port for the OAuth callback (default: `9876`); the redirect URI is `http://127.0.0.1:<port>/oauth/callback` |
| `GOOGLE_ACCOUNTS_DIR` | No | Token storage directory (default: `~/.google-mcp-accounts`) |

## Architecture

- **TypeScript** with ES modules, compiled to `build/`
- **Single OAuth2Client per account** — shared across all services, auto-refreshes tokens
- **Token persistence** — refreshed tokens written to disk automatically with per-account write locks
- **Centralized error handling** — all tool handlers wrapped at the dispatch level in `index.ts`
- **Flat service module pattern** — each service exports `tools` and `register()`, aggregated by `index.ts`
