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

export const tools: Tool[] = [
  {
    name: 'google_sheets_create',
    description: 'Create a new Google Sheets spreadsheet',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Title of the new spreadsheet',
        },
        sheet_name: {
          type: 'string',
          description: 'Name of the first sheet (defaults to Sheet1)',
        },
        parent_id: {
          type: 'string',
          description: 'Google Drive folder ID to move the spreadsheet into',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'google_sheets_get_metadata',
    description: 'Get metadata for a Google Sheets spreadsheet including title, locale, and sheet names/IDs/dimensions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The ID of the spreadsheet',
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['spreadsheet_id'],
    },
  },
  {
    name: 'google_sheets_read',
    description: 'Read cell values from a range in a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The ID of the spreadsheet',
        },
        range: {
          type: 'string',
          description: "The A1 notation range to read (e.g. 'Sheet1!A1:D10')",
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'google_sheets_write',
    description: 'Write values to a range in a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The ID of the spreadsheet',
        },
        range: {
          type: 'string',
          description: "The A1 notation range to write to (e.g. 'Sheet1!A1:D10')",
        },
        values: {
          type: 'array',
          description: '2D array of values to write (rows of columns)',
          items: {
            type: 'array',
            items: {},
          },
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  {
    name: 'google_sheets_append',
    description: 'Append rows to a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The ID of the spreadsheet',
        },
        range: {
          type: 'string',
          description: "The A1 notation range to append to (e.g. 'Sheet1!A:D')",
        },
        values: {
          type: 'array',
          description: '2D array of values to append (rows of columns)',
          items: {
            type: 'array',
            items: {},
          },
        },
        account_email: {
          type: 'string',
          description: ACCOUNT_EMAIL_DESCRIPTION,
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_sheets_create', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const title = args.title as string | undefined;
    if (!title) return error('Missing required parameter: title');

    const sheetName = (args.sheet_name as string | undefined) || 'Sheet1';
    const parentId = args.parent_id as string | undefined;

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: sheetName } }],
      },
    });

    const spreadsheetId = res.data.spreadsheetId;
    if (!spreadsheetId) return error('Failed to create spreadsheet: no ID returned');

    if (parentId) {
      try {
        const drive = google.drive({ version: 'v3', auth });
        const file = await drive.files.get({
          fileId: spreadsheetId,
          fields: 'parents',
        });
        const previousParents = (file.data.parents || []).join(',');
        await drive.files.update({
          fileId: spreadsheetId,
          addParents: parentId,
          removeParents: previousParents || undefined,
          fields: 'id, parents',
        });
      } catch (moveErr) {
        return json({
          spreadsheet_id: spreadsheetId,
          title: res.data.properties?.title,
          url: res.data.spreadsheetUrl,
          sheet_name: sheetName,
          warning: `Spreadsheet created but failed to move to folder: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
        });
      }
    }

    return json({
      spreadsheet_id: spreadsheetId,
      title: res.data.properties?.title,
      url: res.data.spreadsheetUrl,
      sheet_name: sheetName,
    });
  });

  handleCall('google_sheets_get_metadata', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const spreadsheetId = args.spreadsheet_id as string | undefined;
    if (!spreadsheetId) return error('Missing required parameter: spreadsheet_id');

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.get({ spreadsheetId });

    return json({
      title: res.data.properties?.title,
      locale: res.data.properties?.locale,
      sheets: (res.data.sheets || []).map((s) => ({
        name: s.properties?.title,
        sheet_id: s.properties?.sheetId,
        row_count: s.properties?.gridProperties?.rowCount,
        column_count: s.properties?.gridProperties?.columnCount,
      })),
    });
  });

  handleCall('google_sheets_read', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const spreadsheetId = args.spreadsheet_id as string | undefined;
    const range = args.range as string | undefined;
    if (!spreadsheetId) return error('Missing required parameter: spreadsheet_id');
    if (!range) return error('Missing required parameter: range');

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });

    return json({ range: res.data.range, values: res.data.values || [] });
  });

  handleCall('google_sheets_write', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const spreadsheetId = args.spreadsheet_id as string | undefined;
    const range = args.range as string | undefined;
    const values = args.values as unknown[][] | undefined;
    if (!spreadsheetId) return error('Missing required parameter: spreadsheet_id');
    if (!range) return error('Missing required parameter: range');
    if (!values) return error('Missing required parameter: values');

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    return json({
      updated_range: res.data.updatedRange,
      updated_rows: res.data.updatedRows,
      updated_columns: res.data.updatedColumns,
      updated_cells: res.data.updatedCells,
    });
  });

  handleCall('google_sheets_append', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const spreadsheetId = args.spreadsheet_id as string | undefined;
    const range = args.range as string | undefined;
    const values = args.values as unknown[][] | undefined;
    if (!spreadsheetId) return error('Missing required parameter: spreadsheet_id');
    if (!range) return error('Missing required parameter: range');
    if (!values) return error('Missing required parameter: values');

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    return json({
      updated_range: res.data.updates?.updatedRange,
      updated_rows: res.data.updates?.updatedRows,
      updated_columns: res.data.updates?.updatedColumns,
      updated_cells: res.data.updates?.updatedCells,
    });
  });
}
