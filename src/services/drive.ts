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
    description: 'Share a file with a user by email',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: 'The ID of the file to share',
        },
        email: {
          type: 'string',
          description: 'Email address to share with',
        },
        role: {
          type: 'string',
          enum: ['reader', 'writer', 'commenter'],
          description: 'Permission role to grant',
        },
        type: {
          type: 'string',
          description: 'Permission type (default: user)',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['file_id', 'email', 'role'],
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
    const auth = await getAuth(args.account_email as string | undefined);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = args.file_id as string | undefined;
    const email = args.email as string | undefined;
    const role = args.role as string | undefined;
    if (!fileId) return error('Missing required parameter: file_id');
    if (!email) return error('Missing required parameter: email');
    if (!role) return error('Missing required parameter: role');

    const res = await drive.permissions.create({
      fileId,
      requestBody: {
        role,
        type: (args.type as string | undefined) || 'user',
        emailAddress: email,
      },
      fields: 'id,role,type,emailAddress',
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
      fields: 'permissions(id,role,type,emailAddress,displayName)',
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
