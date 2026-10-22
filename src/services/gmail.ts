import { google } from 'googleapis';
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

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function extractPlainTextBody(payload: any): string {
  if (!payload) return '';

  // Direct body on the payload (no parts)
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Walk parts recursively
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const nested = extractPlainTextBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

export const tools: Tool[] = [
  {
    name: 'google_gmail_list',
    description: 'List Gmail messages. Supports Gmail search queries like "from:user@example.com" or "is:unread".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. "from:user@example.com is:unread")' },
        max_results: { type: 'number', description: 'Maximum number of messages to return (default 20)' },
        page_token: { type: 'string', description: 'Token for paginating through results' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
    },
  },
  {
    name: 'google_gmail_read',
    description: 'Read a specific Gmail message by ID. Returns headers and plain text body.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'google_gmail_send',
    description: 'Send an email via Gmail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Plain text email body' },
        cc: { type: 'string', description: 'CC recipient(s)' },
        bcc: { type: 'string', description: 'BCC recipient(s)' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_gmail_list', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const query = args.query as string | undefined;
    const maxResults = (args.max_results as number) || 20;
    const pageToken = args.page_token as string | undefined;

    const gmail = google.gmail({ version: 'v1', auth });

    const { data: listResult } = await gmail.users.messages.list({
      userId: 'me',
      q: query || undefined,
      maxResults,
      pageToken: pageToken || undefined,
    });

    const messages = listResult.messages || [];

    const results = await Promise.all(
      messages.filter(msg => msg.id).map(async (msg) => {
        const { data } = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id as string,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        });

        const headers = data.payload?.headers || [];
        return {
          id: data.id,
          threadId: data.threadId,
          subject: getHeader(headers, 'Subject'),
          from: getHeader(headers, 'From'),
          date: getHeader(headers, 'Date'),
          snippet: data.snippet,
        };
      }),
    );

    return json({
      messages: results,
      next_page_token: listResult.nextPageToken || null,
      result_size_estimate: listResult.resultSizeEstimate,
    });
  });

  handleCall('google_gmail_read', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const messageId = args.message_id as string | undefined;
    if (!messageId) return error('Missing required parameter: message_id');

    const gmail = google.gmail({ version: 'v1', auth });

    const { data } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = data.payload?.headers || [];
    const body = extractPlainTextBody(data.payload);

    return json({
      id: data.id,
      threadId: data.threadId,
      subject: getHeader(headers, 'Subject'),
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      date: getHeader(headers, 'Date'),
      body,
      labels: data.labelIds,
    });
  });

  handleCall('google_gmail_send', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const to = args.to ? sanitizeHeader(args.to as string) : undefined;
    const subject = args.subject ? sanitizeHeader(args.subject as string) : undefined;
    const body = args.body as string | undefined;
    if (!to) return error('Missing required parameter: to');
    if (!subject) return error('Missing required parameter: subject');
    if (!body) return error('Missing required parameter: body');
    const cc = args.cc ? sanitizeHeader(args.cc as string) : undefined;
    const bcc = args.bcc ? sanitizeHeader(args.bcc as string) : undefined;

    const gmail = google.gmail({ version: 'v1', auth });

    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
    ];
    if (cc) messageParts.splice(1, 0, `Cc: ${cc}`);
    if (bcc) messageParts.splice(1, 0, `Bcc: ${bcc}`);
    messageParts.push('', body);

    const raw = Buffer.from(messageParts.join('\r\n')).toString('base64url');

    const { data: sent } = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return json({
      id: sent.id,
      threadId: sent.threadId,
      labels: sent.labelIds,
    });
  });
}
