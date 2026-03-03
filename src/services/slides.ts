import { google } from 'googleapis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse, GetAuthClient } from '../util/types.js';

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
    name: 'google_slides_get',
    description: 'Get metadata for a Google Slides presentation including title, slide count, and slide IDs/titles',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presentation_id: {
          type: 'string',
          description: 'The ID of the presentation',
        },
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'google_slides_create',
    description: 'Create a new Google Slides presentation',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Title of the new presentation',
        },
        parent_id: {
          type: 'string',
          description: 'Google Drive folder ID to move the presentation into',
        },
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'google_slides_add_slide',
    description: 'Add a new slide to a Google Slides presentation',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presentation_id: {
          type: 'string',
          description: 'The ID of the presentation',
        },
        layout: {
          type: 'string',
          description: "Predefined layout for the new slide (e.g. 'BLANK', 'TITLE', 'TITLE_AND_BODY'). Defaults to 'BLANK'.",
        },
        insertion_index: {
          type: 'number',
          description: 'Zero-based index where the slide should be inserted. Appended at the end if not specified.',
        },
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'google_slides_update',
    description:
      'Apply batch updates to a Google Slides presentation. Supports operations like replaceAllText, insertText, createShape, deleteObject, updateTextStyle, and more.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presentation_id: {
          type: 'string',
          description: 'The ID of the presentation',
        },
        requests: {
          type: 'array',
          description: 'Array of Slides API batchUpdate request objects',
          items: {
            type: 'object',
          },
        },
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: ['presentation_id', 'requests'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_slides_get', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const presentationId = args.presentation_id as string | undefined;
    if (!presentationId) return error('Missing required parameter: presentation_id');

    const slides = google.slides({ version: 'v1', auth });
    const res = await slides.presentations.get({ presentationId });

    const slidesList = (res.data.slides || []).map((s) => ({
      object_id: s.objectId,
      title:
        s.pageElements
          ?.find((e) => e.shape?.placeholder?.type === 'TITLE' || e.shape?.placeholder?.type === 'CENTERED_TITLE')
          ?.shape?.text?.textElements?.find((t) => t.textRun)?.textRun?.content?.trim() || null,
    }));

    return json({
      presentation_id: res.data.presentationId,
      title: res.data.title,
      slide_count: (res.data.slides || []).length,
      slides: slidesList,
    });
  });

  handleCall('google_slides_create', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const title = args.title as string | undefined;
    if (!title) return error('Missing required parameter: title');

    const parentId = args.parent_id as string | undefined;

    const slides = google.slides({ version: 'v1', auth });
    const res = await slides.presentations.create({
      requestBody: { title },
    });

    const presentationId = res.data.presentationId;
    if (!presentationId) return error('Failed to create presentation: no ID returned');

    if (parentId) {
      try {
        const drive = google.drive({ version: 'v3', auth });
        const file = await drive.files.get({
          fileId: presentationId,
          fields: 'parents',
        });
        const previousParents = (file.data.parents || []).join(',');
        await drive.files.update({
          fileId: presentationId,
          addParents: parentId,
          removeParents: previousParents || undefined,
          fields: 'id, parents',
        });
      } catch (moveErr) {
        return json({
          presentation_id: presentationId,
          title: res.data.title,
          url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          slide_count: (res.data.slides || []).length,
          warning: `Presentation created but failed to move to folder: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
        });
      }
    }

    return json({
      presentation_id: presentationId,
      title: res.data.title,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
      slide_count: (res.data.slides || []).length,
    });
  });

  handleCall('google_slides_add_slide', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const presentationId = args.presentation_id as string | undefined;
    if (!presentationId) return error('Missing required parameter: presentation_id');

    const layout = (args.layout as string | undefined) || 'BLANK';
    const validLayouts = ['BLANK', 'CAPTION_ONLY', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS', 'TITLE_ONLY', 'SECTION_HEADER', 'SECTION_TITLE_AND_DESCRIPTION', 'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER'];
    if (!validLayouts.includes(layout)) {
      return error(`Invalid layout: ${layout}. Must be one of: ${validLayouts.join(', ')}`);
    }
    const insertionIndex = args.insertion_index as number | undefined;
    if (insertionIndex !== undefined && (!Number.isInteger(insertionIndex) || insertionIndex < 0)) {
      return error('insertion_index must be a non-negative integer');
    }

    const createSlideRequest: Record<string, unknown> = {
      slideLayoutReference: { predefinedLayout: layout },
    };
    if (insertionIndex !== undefined) {
      createSlideRequest.insertionIndex = insertionIndex;
    }

    const slides = google.slides({ version: 'v1', auth });
    const res = await slides.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{ createSlide: createSlideRequest }],
      },
    });

    const reply = res.data.replies?.[0]?.createSlide;

    return json({
      presentation_id: presentationId,
      created_slide_id: reply?.objectId,
    });
  });

  handleCall('google_slides_update', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const presentationId = args.presentation_id as string | undefined;
    const requests = args.requests as Record<string, unknown>[] | undefined;
    if (!presentationId) return error('Missing required parameter: presentation_id');
    if (!requests || requests.length === 0) return error('Missing required parameter: requests');

    const slides = google.slides({ version: 'v1', auth });
    const res = await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    });

    return json({
      presentation_id: res.data.presentationId,
      replies_count: (res.data.replies || []).length,
      replies: res.data.replies,
    });
  });
}
