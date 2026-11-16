import { google } from 'googleapis';
import { Readable } from 'node:stream';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse, GetAuthClient } from '../util/types.js';
import { ACCOUNT_EMAIL_DESCRIPTION } from '../util/account-docs.js';

function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

function json(data: unknown): ToolResponse {
  return ok(JSON.stringify(data, null, 2));
}

function error(msg: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

function clampPageSize(value: unknown, defaultSize: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultSize;
  return Math.min(Math.max(1, n), 1000);
}

const PERMISSION_FIELDS = 'id,role,type,emailAddress,domain,allowFileDiscovery';

const SHARE_ROLES = ['reader', 'commenter', 'writer'] as const;
const SHARE_TYPES = ['user', 'group', 'domain', 'anyone'] as const;
type ShareType = (typeof SHARE_TYPES)[number];

export interface SharePermissionRequest {
  requestBody: {
    role: string;
    type: ShareType;
    emailAddress?: string;
    domain?: string;
    allowFileDiscovery?: boolean;
  };
  sendNotificationEmail?: boolean;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined | { error: string } {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return { error: `${key} must be a string` };
  const t = v.trim();
  return t === '' ? undefined : t;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined | { error: string } {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') return { error: `${key} must be a boolean` };
  return v;
}

/**
 * Builds the permissions.create request for google_drive_share, sending only the
 * fields the Drive API accepts for the permission type. Returns an error message
 * when the arguments do not fit the type.
 */
export function buildSharePermission(args: Record<string, unknown>): SharePermissionRequest | string {
  const role = args.role;
  if (role === undefined || role === null || role === '') return 'Missing required parameter: role';
  if (typeof role !== 'string' || !(SHARE_ROLES as readonly string[]).includes(role)) {
    return `role must be one of: ${SHARE_ROLES.join(', ')}`;
  }

  const rawType = args.type ?? 'user';
  if (typeof rawType !== 'string' || !(SHARE_TYPES as readonly string[]).includes(rawType)) {
    return `type must be one of: ${SHARE_TYPES.join(', ')}`;
  }
  const type = rawType as ShareType;

  const email = optionalString(args, 'email');
  const domain = optionalString(args, 'domain');
  const discovery = optionalBoolean(args, 'allow_file_discovery');
  const notify = optionalBoolean(args, 'send_notification');
  for (const v of [email, domain, discovery, notify]) {
    if (typeof v === 'object') return v.error;
  }

  if (type === 'user' || type === 'group') {
    if (!email) return `Missing required parameter: email (required for type "${type}")`;
    if (domain !== undefined) return `domain is only allowed for type "domain", not "${type}"`;
    if (discovery !== undefined) return `allow_file_discovery is only allowed for type "anyone" or "domain", not "${type}"`;
    return {
      requestBody: { role, type, emailAddress: email as string },
      sendNotificationEmail: (notify as boolean | undefined) ?? false,
    };
  }

  if (email !== undefined) return `email is not allowed for type "${type}"`;
  if (notify !== undefined) return `send_notification is only allowed for type "user" or "group", not "${type}"`;
  const allowFileDiscovery = (discovery as boolean | undefined) ?? false;

  if (type === 'domain') {
    if (!domain) return 'Missing required parameter: domain (required for type "domain")';
    return { requestBody: { role, type, domain: domain as string, allowFileDiscovery } };
  }

  if (domain !== undefined) return 'domain is only allowed for type "domain", not "anyone"';
  return { requestBody: { role, type, allowFileDiscovery } };
}

export const tools: Tool[] = [
  {
    name: 'google_drive_list',
    description: 'List files and folders in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Google Drive query string (e.g. "mimeType=\'application/vnd.google-apps.folder\'")',
        },
        page_size: {
          type: 'number',
          description: 'Number of results to return (default 20)',
        },
        page_token: {
          type: 'string',
          description: 'Token for fetching the next page of results',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
    },
  },
  {
    name: 'google_drive_get',
    description: 'Get metadata for a specific file or folder in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to get metadata for',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'google_drive_read',
    description:
      'Read the content of a file in Google Drive. Exports Google Docs/Sheets/Slides to text; returns raw content for other file types.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to read',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'google_drive_create_file',
    description: 'Create a new file in Google Drive with the given content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the file to create',
        },
        content: {
          type: 'string',
          description: 'Text content of the file',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type of the file (default: text/plain)',
        },
        parent_id: {
          type: 'string',
          description: 'ID of the parent folder',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'google_drive_create_folder',
    description: 'Create a new folder in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the folder to create',
        },
        parent_id: {
          type: 'string',
          description: 'ID of the parent folder',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'google_drive_update',
    description: 'Update the metadata (name, description) of a file in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to update',
        },
        name: {
          type: 'string',
          description: 'New name for the file',
        },
        description: {
          type: 'string',
          description: 'New description for the file',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'google_drive_upload',
    description: 'Upload or replace the content of an existing file in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to update',
        },
        content: {
          type: 'string',
          description: 'New text content for the file',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type of the content',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id', 'content'],
    },
  },
  {
    name: 'google_drive_delete',
    description: 'Delete a file from Google Drive. By default moves to trash; set permanent=true to delete permanently.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to delete',
        },
        permanent: {
          type: 'boolean',
          description: 'If true, permanently delete instead of trashing (default: false)',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'google_drive_copy',
    description: 'Create a copy of a file in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to copy',
        },
        name: {
          type: 'string',
          description: 'Name for the copy',
        },
        parent_id: {
          type: 'string',
          description: 'ID of the parent folder for the copy',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'google_drive_move',
    description: 'Move a file to a different folder in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to move',
        },
        new_parent_id: {
          type: 'string',
          description: 'The ID of the destination folder',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id', 'new_parent_id'],
    },
  },
  {
    name: 'google_drive_search',
    description: 'Search for files in Google Drive by full-text query',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        page_size: {
          type: 'number',
          description: 'Number of results to return (default 20)',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'google_drive_share',
    description:
      'Share a file with a user, a group, everyone in a domain, or anyone with the link. ' +
      'type "user" or "group" needs email; type "domain" needs domain; type "anyone" (link sharing) takes neither.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to share',
        },
        role: {
          type: 'string',
          enum: [...SHARE_ROLES],
          description: 'Permission role to grant',
        },
        type: {
          type: 'string',
          enum: [...SHARE_TYPES],
          description:
            'Who the permission is for (default: user). "anyone" makes the file viewable by anyone with the link.',
        },
        email: {
          type: 'string',
          description: 'Email address of the user or group. Required for type "user" and "group"; not allowed otherwise.',
        },
        domain: {
          type: 'string',
          description: 'Domain to share with (e.g. "example.com"). Required for type "domain"; not allowed otherwise.',
        },
        allow_file_discovery: {
          type: 'boolean',
          description:
            'For type "anyone" or "domain" only: whether the file can be found by search rather than only through its link (default: false).',
        },
        send_notification: {
          type: 'boolean',
          description: 'For type "user" or "group" only: whether to email the recipient about the share (default: false).',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id', 'role'],
    },
  },
  {
    name: 'google_drive_unshare',
    description: 'Remove a sharing permission from a file',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file',
        },
        permission_id: {
          type: 'string',
          description: 'The ID of the permission to remove',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id', 'permission_id'],
    },
  },
  {
    name: 'google_drive_get_permissions',
    description: 'List all sharing permissions for a file',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'google_drive_export',
    description: 'Export a Google Workspace file (Docs, Sheets, Slides) to a specific format',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to export',
        },
        mime_type: {
          type: 'string',
          description: 'Target MIME type (e.g. application/pdf, text/csv)',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id', 'mime_type'],
    },
  },
  {
    name: 'google_drive_get_comments',
    description: 'Get comments on a file in Google Drive',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file',
        },
        page_size: {
          type: 'number',
          description: 'Number of comments to return (default 20)',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  // --- google_drive_list ---
  handleCall('google_drive_list', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.list({
      q: (args.query as string | undefined) || undefined,
      pageSize: clampPageSize(args.page_size, 20),
      pageToken: (args.page_token as string | undefined) || undefined,
      fields: 'files(id,name,mimeType,modifiedTime,size,parents),nextPageToken',
    });

    return json(res.data);
  });

  // --- google_drive_get ---
  handleCall('google_drive_get', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');

    const res = await drive.files.get({
      fileId,
      fields: '*',
    });

    return json(res.data);
  });

  // --- google_drive_read ---
  handleCall('google_drive_read', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');

    // First get metadata to determine mimeType
    const meta = await drive.files.get({ fileId, fields: 'mimeType,name' });
    const mimeType = meta.data.mimeType || '';

    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
      return ok(res.data as string);
    }

    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export({ fileId, mimeType: 'text/csv' });
      return ok(res.data as string);
    }

    if (mimeType === 'application/vnd.google-apps.presentation') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
      return ok(res.data as string);
    }

    // For other files, get raw content
    const textMimeTypes = ['text/', 'application/json', 'application/xml', 'application/javascript'];
    const isTextFile = textMimeTypes.some(prefix => mimeType.startsWith(prefix));

    if (isTextFile) {
      const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'text' },
      );
      return ok(res.data as string);
    }

    return json({ message: `Binary file (${mimeType}) — content cannot be displayed as text`, name: meta.data.name, mimeType });
  });

  // --- google_drive_create_file ---
  handleCall('google_drive_create_file', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const name = args.name as string | undefined;
    const content = args.content;
    if (!name) return error('Missing required parameter: name');
    if (content === undefined || typeof content !== 'string') return error('Missing required parameter: content');

    const fileMetadata: Record<string, unknown> = { name };
    if (args.parent_id) {
      fileMetadata.parents = [args.parent_id as string];
    }

    const res = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: (args.mime_type as string | undefined) || 'text/plain',
        body: Readable.from(content),
      },
      fields: 'id,name,mimeType,modifiedTime',
    });

    return json(res.data);
  });

  // --- google_drive_create_folder ---
  handleCall('google_drive_create_folder', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const name = args.name as string | undefined;
    if (!name) return error('Missing required parameter: name');

    const fileMetadata: Record<string, unknown> = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (args.parent_id) {
      fileMetadata.parents = [args.parent_id as string];
    }

    const res = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id,name,mimeType',
    });

    return json(res.data);
  });

  // --- google_drive_update ---
  handleCall('google_drive_update', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');

    const requestBody: Record<string, unknown> = {};
    if (args.name !== undefined) requestBody.name = args.name as string;
    if (args.description !== undefined) requestBody.description = args.description as string;

    const res = await drive.files.update({
      fileId,
      requestBody,
      fields: 'id,name,description,mimeType,modifiedTime',
    });

    return json(res.data);
  });

  // --- google_drive_upload ---
  handleCall('google_drive_upload', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    const content = args.content;
    if (!fileId) return error('Missing required parameter: file_id');
    if (content === undefined || typeof content !== 'string') return error('Missing required parameter: content');

    const res = await drive.files.update({
      fileId,
      media: {
        mimeType: (args.mime_type as string | undefined) || undefined,
        body: Readable.from(content),
      },
      fields: 'id,name,mimeType,modifiedTime',
    });

    return json(res.data);
  });

  // --- google_drive_delete ---
  handleCall('google_drive_delete', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');
    const permanent = typeof args.permanent === 'boolean' ? args.permanent : false;

    if (permanent) {
      await drive.files.delete({ fileId });
      return ok(`File ${fileId} permanently deleted`);
    }

    await drive.files.update({ fileId, requestBody: { trashed: true } });
    return ok(`File ${fileId} moved to trash`);
  });

  // --- google_drive_copy ---
  handleCall('google_drive_copy', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');

    const requestBody: Record<string, unknown> = {};
    if (args.name !== undefined) requestBody.name = args.name as string;
    if (args.parent_id !== undefined) requestBody.parents = [args.parent_id as string];

    const res = await drive.files.copy({
      fileId,
      requestBody,
      fields: 'id,name,mimeType,modifiedTime',
    });

    return json(res.data);
  });

  // --- google_drive_move ---
  handleCall('google_drive_move', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    const newParentId = args.new_parent_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');
    if (!newParentId) return error('Missing required parameter: new_parent_id');

    // Get current parents
    const current = await drive.files.get({ fileId, fields: 'parents' });
    const previousParents = (current.data.parents || []).join(',');

    const res = await drive.files.update({
      fileId,
      addParents: newParentId,
      removeParents: previousParents || undefined,
      fields: 'id,name,parents',
    });

    return json(res.data);
  });

  // --- google_drive_search ---
  handleCall('google_drive_search', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const query = args.query as string | undefined;
    if (!query) return error('Missing required parameter: query');

    const res = await drive.files.list({
      q: `fullText contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, ' ')}'`,
      pageSize: clampPageSize(args.page_size, 20),
      fields: 'files(id,name,mimeType,modifiedTime,size,parents),nextPageToken',
    });

    return json(res.data);
  });

  // --- google_drive_share ---
  handleCall('google_drive_share', async (args) => {
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');
    const request = buildSharePermission(args);
    if (typeof request === 'string') return error(request);

    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.permissions.create({
      fileId,
      requestBody: request.requestBody,
      ...(request.sendNotificationEmail === undefined ? {} : { sendNotificationEmail: request.sendNotificationEmail }),
      fields: PERMISSION_FIELDS,
    });

    return json(res.data);
  });

  // --- google_drive_unshare ---
  handleCall('google_drive_unshare', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    const permissionId = args.permission_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');
    if (!permissionId) return error('Missing required parameter: permission_id');

    await drive.permissions.delete({ fileId, permissionId });

    return ok(`Permission ${permissionId} removed from file ${fileId}`);
  });

  // --- google_drive_get_permissions ---
  handleCall('google_drive_get_permissions', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');

    const res = await drive.permissions.list({
      fileId,
      fields: `permissions(${PERMISSION_FIELDS},displayName)`,
    });

    return json(res.data);
  });

  // --- google_drive_export ---
  handleCall('google_drive_export', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    const mimeType = args.mime_type as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');
    if (!mimeType) return error('Missing required parameter: mime_type');

    const textExportTypes = ['text/', 'application/json', 'application/xml', 'application/javascript'];
    const isTextExport = textExportTypes.some(prefix => mimeType.startsWith(prefix));

    if (isTextExport) {
      const res = await drive.files.export({ fileId, mimeType });
      return ok(res.data as string);
    }

    const res = await drive.files.export(
      { fileId, mimeType },
      { responseType: 'arraybuffer' },
    );
    const base64 = Buffer.from(res.data as ArrayBuffer).toString('base64');
    return json({ encoding: 'base64', mimeType, content: base64 });
  });

  // --- google_drive_get_comments ---
  handleCall('google_drive_get_comments', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');

    const res = await drive.comments.list({
      fileId,
      pageSize: clampPageSize(args.page_size, 20),
      fields: 'comments(id,content,author,createdTime,resolved),nextPageToken',
    });

    return json(res.data);
  });
}
