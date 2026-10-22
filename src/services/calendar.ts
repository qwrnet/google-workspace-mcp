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
    name: 'google_calendar_list_events',
    description: 'List events from a Google Calendar. Supports filtering by time range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar_id: { type: 'string', description: 'Calendar ID (defaults to "primary")' },
        time_min: { type: 'string', description: 'Lower bound (inclusive) for event start time, as ISO 8601 datetime' },
        time_max: { type: 'string', description: 'Upper bound (exclusive) for event start time, as ISO 8601 datetime' },
        max_results: { type: 'number', description: 'Maximum number of events to return (default 25)' },
        page_token: { type: 'string', description: 'Token for paginating through results' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
    },
  },
  {
    name: 'google_calendar_create_event',
    description: 'Create a new event on a Google Calendar. Use ISO 8601 datetime with "T" for timed events, or date-only (YYYY-MM-DD) for all-day events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time (ISO 8601 datetime for timed events, YYYY-MM-DD for all-day)' },
        end: { type: 'string', description: 'End time (ISO 8601 datetime for timed events, YYYY-MM-DD for all-day)' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        attendees: {
          type: 'array',
          description: 'List of attendee email addresses',
          items: { type: 'string' },
        },
        calendar_id: { type: 'string', description: 'Calendar ID (defaults to "primary")' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'google_calendar_update_event',
    description: 'Update an existing event on a Google Calendar. Only provided fields are changed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'The event ID to update' },
        calendar_id: { type: 'string', description: 'Calendar ID (defaults to "primary")' },
        summary: { type: 'string', description: 'New event title' },
        start: { type: 'string', description: 'New start time (ISO 8601 datetime or YYYY-MM-DD)' },
        end: { type: 'string', description: 'New end time (ISO 8601 datetime or YYYY-MM-DD)' },
        description: { type: 'string', description: 'New event description' },
        location: { type: 'string', description: 'New event location' },
        attendees: {
          type: 'array',
          description: 'New list of attendee email addresses (replaces existing)',
          items: { type: 'string' },
        },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'google_calendar_delete_event',
    description:
      'Delete an event from a Google Calendar. Fetches the event first and reports its title and start. ' +
      'Not found or already deleted (404/410) and no permission (403: not the organizer, or a read-only ' +
      'calendar) come back as readable errors. Events Gmail created from emails (eventType "fromGmail") ' +
      'may refuse API changes; if Google refuses, say to remove it in the Calendar app.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'The event ID to delete' },
        calendar_id: { type: 'string', description: 'Calendar ID (defaults to "primary")' },
        send_updates: {
          type: 'string',
          enum: ['all', 'externalOnly', 'none'],
          description: 'Whether to email guests about the cancellation (defaults to "none")',
        },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['event_id'],
    },
  },
];

/** The HTTP status of a googleapis error, if it has one. */
function statusOf(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const value of [e?.response?.status, e?.status, e?.code]) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}

function buildDateTimeField(value: string): { dateTime: string; timeZone?: string } | { date: string } {
  if (value.includes('T')) {
    // If the value already has a timezone offset or Z, don't inject timeZone
    if (/(Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/.test(value)) {
      return { dateTime: value };
    }
    return { dateTime: value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  return { date: value };
}

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_calendar_list_events', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const calendarId = (args.calendar_id as string) || 'primary';
    const maxResults = (args.max_results as number) || 25;
    const pageToken = args.page_token as string | undefined;
    const timeMin = args.time_min as string | undefined;
    const timeMax = args.time_max as string | undefined;

    const calendar = google.calendar({ version: 'v3', auth });

    const { data } = await calendar.events.list({
      calendarId,
      timeMin: timeMin || undefined,
      timeMax: timeMax || undefined,
      maxResults,
      pageToken: pageToken || undefined,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (data.items || []).map((event) => ({
      id: event.id,
      summary: event.summary,
      start: event.start,
      end: event.end,
      location: event.location,
      attendees: event.attendees?.map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
      htmlLink: event.htmlLink,
    }));

    return json({
      events,
      next_page_token: data.nextPageToken || null,
    });
  });

  handleCall('google_calendar_create_event', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const calendarId = (args.calendar_id as string) || 'primary';
    const summary = args.summary as string | undefined;
    const start = args.start as string | undefined;
    const end = args.end as string | undefined;
    if (!summary) return error('Missing required parameter: summary');
    if (!start) return error('Missing required parameter: start');
    if (!end) return error('Missing required parameter: end');
    const description = args.description as string | undefined;
    const location = args.location as string | undefined;
    const attendees = args.attendees as string[] | undefined;

    const calendar = google.calendar({ version: 'v3', auth });

    const eventResource: any = {
      summary,
      start: buildDateTimeField(start),
      end: buildDateTimeField(end),
    };

    if (description) eventResource.description = description;
    if (location) eventResource.location = location;
    if (attendees) eventResource.attendees = attendees.map((email) => ({ email }));

    const { data: created } = await calendar.events.insert({
      calendarId,
      requestBody: eventResource,
    });

    return json({
      id: created.id,
      summary: created.summary,
      start: created.start,
      end: created.end,
      htmlLink: created.htmlLink,
    });
  });

  handleCall('google_calendar_delete_event', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const eventId = args.event_id as string | undefined;
    if (!eventId) return error('Missing required parameter: event_id');
    const calendarId = (args.calendar_id as string) || 'primary';
    const sendUpdates = (args.send_updates as string) || 'none';
    if (!['all', 'externalOnly', 'none'].includes(sendUpdates)) {
      return error('send_updates must be one of all, externalOnly, none');
    }
    const calendar = google.calendar({ version: 'v3', auth });

    let existing;
    try {
      ({ data: existing } = await calendar.events.get({ calendarId, eventId }));
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 410) return error(`Event ${eventId} was not found (already deleted?)`);
      if (status === 403) return error(`No permission to read event ${eventId} on calendar ${calendarId}`);
      throw err;
    }
    if (existing.status === 'cancelled') return error(`Event ${eventId} is already deleted`);

    try {
      await calendar.events.delete({ calendarId, eventId, sendUpdates });
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 410) return error(`Event ${eventId} was not found (already deleted?)`);
      if (status === 403 || status === 400) {
        const gmail = existing.eventType === 'fromGmail'
          ? ' It was created by Gmail from an email; remove it in the Calendar app instead.'
          : ' Only the organizer can delete it, and the calendar must be writable.';
        return error(`Google refused to delete "${existing.summary ?? eventId}" (${status}).${gmail}`);
      }
      throw err;
    }
    return json({
      deleted: true,
      id: eventId,
      summary: existing.summary,
      start: existing.start,
      eventType: existing.eventType,
      sendUpdates,
    });
  });

  handleCall('google_calendar_update_event', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const eventId = args.event_id as string | undefined;
    if (!eventId) return error('Missing required parameter: event_id');
    const calendarId = (args.calendar_id as string) || 'primary';

    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch existing event
    const { data: existing } = await calendar.events.get({
      calendarId,
      eventId,
    });

    // Merge provided fields
    if (args.summary !== undefined) existing.summary = args.summary as string;
    if (args.description !== undefined) existing.description = args.description as string;
    if (args.location !== undefined) existing.location = args.location as string;
    if (args.start !== undefined) existing.start = buildDateTimeField(args.start as string);
    if (args.end !== undefined) existing.end = buildDateTimeField(args.end as string);
    if (args.attendees !== undefined) {
      existing.attendees = (args.attendees as string[]).map((email) => ({ email }));
    }

    const { data: updated } = await calendar.events.update({
      calendarId,
      eventId,
      requestBody: existing,
    });

    return json({
      id: updated.id,
      summary: updated.summary,
      start: updated.start,
      end: updated.end,
      location: updated.location,
      htmlLink: updated.htmlLink,
    });
  });
}
