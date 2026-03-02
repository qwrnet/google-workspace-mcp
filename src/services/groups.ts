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
    name: 'google_groups_list',
    description: 'List Google Groups visible to the authenticated user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: [],
    },
  },
  {
    name: 'google_groups_get_members',
    description: 'Get the members of a Google Group',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group_email: {
          type: 'string',
          description: 'Email address of the group',
        },
        page_size: {
          type: 'number',
          description: 'Maximum number of members to return (default 50)',
        },
        page_token: {
          type: 'string',
          description: 'Token for fetching the next page of results',
        },
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: ['group_email'],
    },
  },
  {
    name: 'google_groups_add_member',
    description: 'Add a member to a Google Group',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group_email: {
          type: 'string',
          description: 'Email address of the group',
        },
        member_email: {
          type: 'string',
          description: 'Email address of the member to add',
        },
        role: {
          type: 'string',
          description: "Role for the new member: 'MEMBER', 'MANAGER', or 'OWNER'. Defaults to 'MEMBER'.",
        },
        account_email: {
          type: 'string',
          description: 'Email of the Google account to use. Defaults to the most recently used account.',
        },
      },
      required: ['group_email', 'member_email'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_groups_list', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);

    const cloudidentity = google.cloudidentity({ version: 'v1', auth });
    try {
      const res = await cloudidentity.groups.search({
        query: "parent == 'customers/my_customer'",
        view: 'BASIC',
      });

      const groups = (res.data.groups || []).map((g) => ({
        name: g.name,
        group_email: g.groupKey?.id,
        display_name: g.displayName,
        description: g.description,
      }));

      return json({ groups, count: groups.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return error(`Failed to list groups. This requires a Google Workspace account with Cloud Identity API access. Error: ${msg}`);
    }
  });

  handleCall('google_groups_get_members', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const groupEmail = args.group_email as string | undefined;
    if (!groupEmail) return error('Missing required parameter: group_email');

    const pageSize = (args.page_size as number | undefined) || 50;
    const pageToken = args.page_token as string | undefined;

    const cloudidentity = google.cloudidentity({ version: 'v1', auth });

    const lookup = await cloudidentity.groups.lookup({ 'groupKey.id': groupEmail });
    const groupName = lookup.data.name;
    if (!groupName) return error(`Could not find group: ${groupEmail}`);

    const res = await cloudidentity.groups.memberships.list({
      parent: groupName,
      pageSize,
      pageToken,
    });

    const members = (res.data.memberships || []).map((m) => ({
      email: m.preferredMemberKey?.id,
      roles: (m.roles || []).map((r) => r.name),
      type: m.type,
    }));

    return json({
      group_email: groupEmail,
      members,
      count: members.length,
      next_page_token: res.data.nextPageToken || null,
    });
  });

  handleCall('google_groups_add_member', async (args) => {
    const auth = await getAuth(args.account_email as string | undefined);
    const groupEmail = args.group_email as string | undefined;
    const memberEmail = args.member_email as string | undefined;
    if (!groupEmail) return error('Missing required parameter: group_email');
    if (!memberEmail) return error('Missing required parameter: member_email');

    const role = (args.role as string | undefined) || 'MEMBER';
    const validRoles = ['MEMBER', 'MANAGER', 'OWNER'];
    if (!validRoles.includes(role)) {
      return error(`Invalid role: ${role}. Must be one of: ${validRoles.join(', ')}`);
    }

    const cloudidentity = google.cloudidentity({ version: 'v1', auth });

    const lookup = await cloudidentity.groups.lookup({ 'groupKey.id': groupEmail });
    const groupName = lookup.data.name;
    if (!groupName) return error(`Could not find group: ${groupEmail}`);

    const res = await cloudidentity.groups.memberships.create({
      parent: groupName,
      requestBody: {
        preferredMemberKey: { id: memberEmail },
        roles: [{ name: role }],
      },
    });

    return json({
      group_email: groupEmail,
      member_email: memberEmail,
      role,
      membership_name: res.data.name,
    });
  });
}
