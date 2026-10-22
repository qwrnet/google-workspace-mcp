import { google } from 'googleapis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse, GetAuthClient } from '../util/types.js';
import { ACCOUNT_EMAIL_DESCRIPTION } from '../util/account-docs.js';
import { docsToText } from '../util/markdown.js';

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
    name: 'google_docs_create',
    description: 'Create a new Google Doc. Optionally insert initial text content and place it in a specific Drive folder.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Initial text content to insert into the document' },
        parent_id: { type: 'string', description: 'Google Drive folder ID to move the document into' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['title'],
    },
  },
  {
    name: 'google_docs_read',
    description: 'Read the content of a Google Doc and return it as readable text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'The Google Doc document ID' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'google_docs_write',
    description: 'Write to a Google Doc by sending batchUpdate requests (insertText, replaceAllText, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'The Google Doc document ID' },
        requests: {
          type: 'array',
          description: 'Array of batchUpdate request objects, e.g. [{ insertText: { text: "hello", location: { index: 1 } } }]',
          items: { type: 'object' },
        },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['document_id', 'requests'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_docs_create', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const title = args.title as string | undefined;
    if (!title) return error('Missing required parameter: title');
    const content = args.content as string | undefined;
    const parentId = args.parent_id as string | undefined;

    const docs = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    const { data: doc } = await docs.documents.create({
      requestBody: { title },
    });

    const documentId = doc.documentId;
    if (!documentId) return error('Failed to create document: no ID returned');

    if (content) {
      try {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  text: content,
                  location: { index: 1 },
                },
              },
            ],
          },
        });
      } catch (contentErr) {
        return json({
          document_id: documentId,
          title: doc.title,
          url: `https://docs.google.com/document/d/${documentId}/edit`,
          warning: `Document created but failed to insert content: ${contentErr instanceof Error ? contentErr.message : String(contentErr)}`,
        });
      }
    }

    if (parentId) {
      try {
        const file = await drive.files.get({
          fileId: documentId,
          fields: 'parents',
        });
        const previousParents = (file.data.parents || []).join(',');
        await drive.files.update({
          fileId: documentId,
          addParents: parentId,
          removeParents: previousParents || undefined,
          fields: 'id, parents',
        });
      } catch (moveErr) {
        return json({
          document_id: documentId,
          title: doc.title,
          url: `https://docs.google.com/document/d/${documentId}/edit`,
          warning: `Document created but failed to move to folder: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
        });
      }
    }

    return json({
      document_id: documentId,
      title: doc.title,
      url: `https://docs.google.com/document/d/${documentId}/edit`,
    });
  });

  handleCall('google_docs_read', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const documentId = args.document_id as string | undefined;
    if (!documentId) return error('Missing required parameter: document_id');

    const docs = google.docs({ version: 'v1', auth });
    const { data: doc } = await docs.documents.get({ documentId });

    const text = doc.body ? docsToText(doc.body) : '';

    return ok(`Title: ${doc.title}\n\n${text}`);
  });

  handleCall('google_docs_write', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const documentId = args.document_id as string | undefined;
    if (!documentId) return error('Missing required parameter: document_id');
    const requests = args.requests as object[];

    if (!requests || !Array.isArray(requests) || requests.length === 0) {
      return error('requests must be a non-empty array of batchUpdate request objects');
    }

    const docs = google.docs({ version: 'v1', auth });
    const { data: result } = await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    return json({
      document_id: result.documentId,
      replies: result.replies,
    });
  });
}
