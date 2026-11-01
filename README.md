# Google Workspace MCP Server

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) server that provides 51 tools for interacting with Google Workspace APIs: Drive, Sheets, Docs, Gmail, Calendar, Slides, Groups, and Contacts.

## Features

- **51 tools** across 9 Google Workspace services
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
   - People API (for the Contacts tools)
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

### OAuth scopes

The server asks for these scopes when an account signs in:

| Scope | Used by |
|-------|---------|
| `userinfo.email`, `userinfo.profile` | Identifying the signed-in account |
| `drive` | Drive tools |
| `spreadsheets` | Sheets tools |
| `documents` | Docs tools |
| `gmail.modify` | Gmail tools |
| `calendar` | Calendar tools |
| `presentations` | Slides tools |
| `cloud-identity.groups.readonly` | Groups tools |
| `contacts` | Contacts tools (read and write; protected labels stay owner-only, see [Contacts](#contacts-8)) |

All are under `https://www.googleapis.com/auth/`. Accounts signed in before a scope was added do not have it: a Contacts call on such an account fails with "has not granted Google Contacts access ... Sign in again to grant Contacts". An account signed in while the server only asked for `contacts.readonly` can still read, but a write fails with "has not granted permission to change Google Contacts ... Sign in again to grant Contacts". Either way, run `google_accounts_auth_start` for that account (with the client shown by `google_accounts_list`) and accept the Contacts permission once.

## Using multiple accounts

Every tool except the account tools takes an optional `account_email`. When it is omitted, the server uses `GOOGLE_DEFAULT_ACCOUNT` if set, otherwise the most recently used account. With more than one account configured, that fallback can silently act as the wrong account, so pass `account_email` explicitly. Use `google_accounts_list` to see the configured accounts.

The server sends MCP `instructions` at startup that tell agents this: list accounts first, pass `account_email` on every call when there are several, keep one account per task (file, message and event IDs belong to the account that returned them), and pass `client` when adding an account from another Workspace org. The text lives in [`src/util/account-docs.ts`](src/util/account-docs.ts), together with the shared `account_email` description that every tool uses.

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

### Gmail (4)

| Tool | Description |
|------|-------------|
| `google_gmail_list` | List/search messages (`has:attachment` finds ones with files) |
| `google_gmail_read` | Read a message: headers, plain text body, and its attachments (`part_id`, filename, MIME type, size) |
| `google_gmail_save_attachment` | Save one attachment to a local file (see below) |
| `google_gmail_send` | Send an email |

`google_gmail_save_attachment` takes `message_id`, a `part_id` from `google_gmail_read`, and an absolute `output_path`. It writes the file to disk, so the bytes never pass through the model's context, and returns `{path, filename, mime_type, bytes_written}`. The attachment is found by `part_id` because Gmail issues a new `attachmentId` each time a message is fetched. Rules:

- `output_path` must be absolute and normalized, its parent directory must already exist, and no part of the parent path may be a symlink.
- An existing file or symlink at `output_path` is never overwritten or followed. The new file has mode `600`.
- Attachments over 25 MB are refused.
- `output_path` must be inside the system temp directory or `~/.cache`, with no dot-named directory or file below that root. Attachment content comes from whoever sent the email, and an email can try to steer the model's choice of path, so this keeps writes away from places like `~/.config/autostart`, `~/.ssh` or a repository's `.git/hooks`. `GOOGLE_ATTACHMENTS_ROOT` replaces the default roots with its own list (separated by `:`).

### Calendar (4)

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

### Contacts (8)

Through the People API. Each contact comes back as `{resource_name, names, emails, phones, addresses, organizations, notes, groups}`: all names, all emails and phones (with type, and the E.164 `canonical` form of each phone when Google has one), postal addresses, company and title, notes (the contact's biography field) and the names of the contact groups (labels) it belongs to.

| Tool | Description |
|------|-------------|
| `google_contacts_search` | Find contacts by exactly one of `email` (exact, case-insensitive, any of the contact's emails), `phone` (digits of any of its numbers; a 10-digit number also matches its +1 form) or `query` (substring of a name or email). Paginated with `page_size` (max 100) and `page_token` |
| `google_contacts_list_groups` | List contact groups (labels) with member counts |
| `google_contacts_list_group_members` | List the contacts in a group, by exact label name (e.g. `Solaris: trusted`) or resource name. Paginated like search |
| `google_contacts_create` | Create a contact from `given_name`, `family_name`, `emails`, `phones`, `addresses`, `organization` (`{company, title}`), `notes` and `labels` (existing label names) |
| `google_contacts_update` | Change a contact's fields by `resource_name`. Only the fields passed change; a list passed (`emails`, `phones`, `addresses`) replaces the whole list, and an empty list or empty `notes` clears it. Uses the contact's etag, so a contact changed in the meantime is reported, not overwritten |
| `google_contacts_delete` | Delete a contact by `resource_name` |
| `google_contacts_create_label` | Create a label |
| `google_contacts_update_label_members` | Add (`add`) or remove (`remove`) contacts by resource name on a label given by exact name or resource name |

Label names are matched exactly, so a near-miss never resolves to a different label. If the People API cannot return some members of a group, they are listed under `failed_members` with a `warning`, never silently left out.

**Protected labels.** A label such as `Solaris: trusted` can serve as a permission list, because no tool can change who is on it. For a protected label, the write tools refuse to add or remove members (`google_contacts_update_label_members`, `labels` on `google_contacts_create`) or to create a label with its name in any letter case. They also refuse to change the `emails` or `phones` of a contact on it, since those decide which sender is that contact, and to delete such a contact. Names, addresses, organization and notes of those contacts can still be edited. There is no tool to rename or delete a label. Only the account owner changes a protected label, in Google Contacts itself. `GOOGLE_CONTACTS_PROTECTED_LABELS` sets the protected labels (comma-separated; default `Solaris: trusted`; empty protects none).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | One of these or `clients.json` | OAuth 2.0 client ID (the `default` client) |
| `GOOGLE_CLIENT_SECRET` | One of these or `clients.json` | OAuth 2.0 client secret (the `default` client) |
| `GOOGLE_OAUTH_CLIENTS_FILE` | No | Path to the named-clients file (default: `<accounts dir>/clients.json`) |
| `GOOGLE_DEFAULT_ACCOUNT` | No | Account used when a tool call omits `account_email` (default: most recently used) |
| `GOOGLE_OAUTH_PORT` | No | Loopback port for the OAuth callback (default: `9876`); the redirect URI is `http://127.0.0.1:<port>/oauth/callback` |
| `GOOGLE_CONTACTS_PROTECTED_LABELS` | No | Contact labels the write tools never change, comma-separated (default: `Solaris: trusted`; empty: none) |
| `GOOGLE_ATTACHMENTS_ROOT` | No | Directories `google_gmail_save_attachment` may write under, separated by `:` (default: the system temp directory and `~/.cache`) |
| `GOOGLE_ACCOUNTS_DIR` | No | Token storage directory (default: `~/.google-mcp-accounts`) |

## Architecture

- **TypeScript** with ES modules, compiled to `build/`
- **Single OAuth2Client per account** — shared across all services, auto-refreshes tokens
- **Token persistence** — refreshed tokens written to disk automatically with per-account write locks
- **Centralized error handling** — all tool handlers wrapped at the dispatch level in `index.ts`
- **Flat service module pattern** — each service exports `tools` and `register()`, aggregated by `index.ts`
