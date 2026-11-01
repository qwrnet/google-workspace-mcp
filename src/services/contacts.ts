import { google, type people_v1 } from 'googleapis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse, GetAuthClient, OAuth2Client } from '../util/types.js';
import { ACCOUNT_EMAIL_DESCRIPTION } from '../util/account-docs.js';
import { accountForClient } from '../auth/accounts.js';

// Read-only by design: this module only ever calls People API read methods, and the server
// requests contacts.readonly, because contact labels (e.g. "Solaris: trusted") are used as
// permission lists. Never add a tool here that creates, updates or deletes contacts.

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,biographies,memberships';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Google caps an account at 25,000 contacts, so 30 pages of 1,000 always covers it. */
const MAX_SCAN_PAGES = 30;
const MAX_GROUP_MEMBERS = 25_000;
const BATCH_GET_LIMIT = 200;

function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

function json(data: unknown): ToolResponse {
  return ok(JSON.stringify(data, null, 2));
}

function error(msg: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

export interface ContactPhone {
  value: string;
  canonical: string | null;
  type: string | null;
}

export interface Contact {
  resource_name: string;
  names: string[];
  emails: Array<{ value: string; type: string | null }>;
  phones: ContactPhone[];
  notes: string[];
  groups: string[];
}

interface GoogleError {
  message?: string;
  code?: number | string;
  status?: number;
  response?: { status?: number; data?: { error?: { message?: string; status?: string; details?: unknown[]; errors?: unknown[] } } };
}

function errorReasons(err: GoogleError): string[] {
  const e = err.response?.data?.error;
  const reasons: string[] = [];
  for (const d of [...(e?.details ?? []), ...(e?.errors ?? [])]) {
    const reason = (d as { reason?: unknown } | null)?.reason;
    if (typeof reason === 'string') reasons.push(reason);
  }
  return reasons;
}

/** True when the token was issued without the contacts scope (accounts signed in before it was added). */
export function isMissingScope(err: unknown): boolean {
  const e = err as GoogleError;
  const status = e?.response?.status ?? e?.status ?? Number(e?.code);
  if (status !== 403) return false;
  if (errorReasons(e).includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) return true;
  const msg = `${e?.message ?? ''} ${e?.response?.data?.error?.message ?? ''}`;
  return /insufficient authentication scopes|insufficient permission/i.test(msg);
}

function isApiDisabled(err: unknown): boolean {
  const e = err as GoogleError;
  if (errorReasons(e).includes('SERVICE_DISABLED') || errorReasons(e).includes('accessNotConfigured')) return true;
  return /People API has not been used|people\.googleapis\.com.*disabled/i.test(e?.message ?? '');
}

function describeError(err: unknown, auth: OAuth2Client, requested: string | undefined, action: string): ToolResponse {
  const acct = accountForClient(auth);
  const email = acct?.email ?? requested;
  if (isMissingScope(err)) {
    const who = email ?? 'This account';
    const client = acct ? ` with client "${acct.client}"` : '';
    return error(
      `${who} has not granted Google Contacts access (contacts.readonly); it was signed in before the server asked for it. ` +
      `Sign in again to grant Contacts: run google_accounts_auth_start${client} and sign in as ${email ?? 'that account'}, ` +
      'then accept the Contacts permission on the consent screen.',
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (isApiDisabled(err)) {
    return error(`The People API is not enabled in this OAuth client's Google Cloud project; enable it in Google Cloud Console (APIs & Services > Library > People API). ${msg}`);
  }
  return error(`Failed to ${action}: ${msg}`);
}

function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/**
 * Whether a stored phone number is the number asked for. Compares digits of both the typed
 * and the canonical (E.164) form, and treats a 10-digit number as matching its +1 form.
 */
export function phoneMatches(queryDigits: string, phone: people_v1.Schema$PhoneNumber): boolean {
  for (const c of [digits(phone.canonicalForm), digits(phone.value)]) {
    if (!c) continue;
    if (c === queryDigits) return true;
    if (queryDigits.length === 10 && c === `1${queryDigits}`) return true;
    if (c.length === 10 && queryDigits === `1${c}`) return true;
  }
  return false;
}

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function groupLabel(g: people_v1.Schema$ContactGroup): string {
  return g.formattedName || g.name || g.resourceName || '';
}

export function toContact(p: people_v1.Schema$Person, groupNames: Map<string, string>): Contact {
  const names = [...new Set((p.names ?? []).map((n) => n.displayName).filter((n): n is string => !!n))];
  return {
    resource_name: p.resourceName ?? '',
    names,
    emails: (p.emailAddresses ?? [])
      .filter((e) => e.value)
      .map((e) => ({ value: e.value!, type: e.formattedType || e.type || null })),
    phones: (p.phoneNumbers ?? [])
      .filter((ph) => ph.value)
      .map((ph) => ({ value: ph.value!, canonical: ph.canonicalForm || null, type: ph.formattedType || ph.type || null })),
    notes: (p.biographies ?? []).map((b) => b.value).filter((v): v is string => !!v),
    groups: (p.memberships ?? [])
      .map((m) => m.contactGroupMembership?.contactGroupResourceName)
      .filter((r): r is string => !!r)
      .map((r) => groupNames.get(r) ?? r),
  };
}

function parsePaging(args: Record<string, unknown>, max = MAX_PAGE_SIZE): { size: number; offset: number } | string {
  const rawSize = args.page_size;
  let size = DEFAULT_PAGE_SIZE;
  if (rawSize !== undefined) {
    if (typeof rawSize !== 'number' || !Number.isInteger(rawSize) || rawSize < 1) return 'page_size must be a positive integer';
    size = Math.min(rawSize, max);
  }
  let offset = 0;
  const token = args.page_token;
  if (token !== undefined && token !== null && token !== '') {
    if (typeof token !== 'string' || !/^\d+$/.test(token)) return 'Invalid page_token';
    offset = Number(token);
  }
  return { size, offset };
}

async function listGroups(people: people_v1.People): Promise<people_v1.Schema$ContactGroup[]> {
  const groups: people_v1.Schema$ContactGroup[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_SCAN_PAGES; i++) {
    const res = await people.contactGroups.list({ pageSize: 1000, pageToken, groupFields: 'name,groupType,memberCount' });
    groups.push(...(res.data.contactGroups ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return groups;
}

function groupNameMap(groups: people_v1.Schema$ContactGroup[]): Map<string, string> {
  return new Map(groups.filter((g) => g.resourceName).map((g) => [g.resourceName!, groupLabel(g)]));
}

/** Every contact in the account (sorted by first name), for exact matching on email or phone. */
async function listAllContacts(people: people_v1.People): Promise<{ people: people_v1.Schema$Person[]; complete: boolean }> {
  const all: people_v1.Schema$Person[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_SCAN_PAGES; i++) {
    const res = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      pageToken,
      personFields: PERSON_FIELDS,
      sortOrder: 'FIRST_NAME_ASCENDING',
    });
    all.push(...(res.data.connections ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) return { people: all, complete: true };
  }
  return { people: all, complete: false };
}

function page<T>(items: T[], size: number, offset: number): { items: T[]; next_page_token: string | null } {
  const slice = items.slice(offset, offset + size);
  const next = offset + size < items.length ? String(offset + size) : null;
  return { items: slice, next_page_token: next };
}

export const tools: Tool[] = [
  {
    name: 'google_contacts_search',
    description:
      'Look up Google Contacts (read-only). Pass exactly one of: email (exact, case-insensitive match on any of a contact\'s emails), ' +
      'phone (match on digits of any of a contact\'s numbers; a 10-digit number also matches its +1 form), or query ' +
      '(case-insensitive substring of a name or email). Returns names, all emails and phones, notes, and contact group (label) names. ' +
      'Results are paginated: pass next_page_token back as page_token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'Email address to find' },
        phone: { type: 'string', description: 'Phone number to find, in any format (e.g. +1 555 123 4567)' },
        query: { type: 'string', description: 'Text to find in contact names or emails' },
        page_size: { type: 'number', description: `Maximum contacts to return (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})` },
        page_token: { type: 'string', description: 'next_page_token from a previous call with the same search' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: 'google_contacts_list_groups',
    description: 'List Google Contacts groups (labels), including system groups such as My Contacts and Starred, with member counts (read-only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: 'google_contacts_list_group_members',
    description:
      'List the contacts in a Google Contacts group (label), e.g. "Solaris: trusted" (read-only). Returns names, all emails and phones, ' +
      'notes, and group names for each member. Paginated: pass next_page_token back as page_token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group: {
          type: 'string',
          description: 'Group (label) name exactly as shown in Google Contacts, or its resource name (contactGroups/...)',
        },
        page_size: { type: 'number', description: `Maximum members to return (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})` },
        page_token: { type: 'string', description: 'next_page_token from a previous call for the same group' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['group'],
    },
  },
];

export function register(
  handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
  getAuth: GetAuthClient,
): void {
  handleCall('google_contacts_search', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const email = typeof args.email === 'string' ? normEmail(args.email) : '';
    const phone = typeof args.phone === 'string' ? digits(args.phone) : '';
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const provided = (v: unknown) => v !== undefined && v !== null && v !== '';
    if ([args.email, args.phone, args.query].filter(provided).length !== 1) return error('Pass exactly one of email, phone or query');
    if (provided(args.email) && !email.includes('@')) return error('email must be an email address');
    if (provided(args.phone) && phone.length < 3) return error('phone must contain at least 3 digits');
    if (provided(args.query) && !query) return error('query must not be empty');
    const paging = parsePaging(args);
    if (typeof paging === 'string') return error(paging);

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const [groups, scan] = await Promise.all([listGroups(people), listAllContacts(people)]);
      const matches = scan.people.filter((p) => {
        if (email) return (p.emailAddresses ?? []).some((e) => normEmail(e.value) === email);
        if (phone) return (p.phoneNumbers ?? []).some((ph) => phoneMatches(phone, ph));
        return (p.names ?? []).some((n) => (n.displayName ?? '').toLowerCase().includes(query))
          || (p.emailAddresses ?? []).some((e) => normEmail(e.value).includes(query));
      });
      const names = groupNameMap(groups);
      const { items, next_page_token } = page(matches, paging.size, paging.offset);
      return json({
        contacts: items.map((p) => toContact(p, names)),
        count: items.length,
        total_matches: matches.length,
        next_page_token,
        ...(scan.complete ? {} : { warning: 'The contact list was too long to scan completely; some matches may be missing.' }),
      });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'search contacts');
    }
  });

  handleCall('google_contacts_list_groups', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const groups = (await listGroups(people)).map((g) => ({
        name: groupLabel(g),
        resource_name: g.resourceName,
        type: g.groupType === 'SYSTEM_CONTACT_GROUP' ? 'system' : 'user',
        member_count: g.memberCount ?? 0,
      }));
      return json({ groups, count: groups.length });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'list contact groups');
    }
  });

  handleCall('google_contacts_list_group_members', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const groupArg = typeof args.group === 'string' ? args.group.trim() : '';
    if (!groupArg) return error('Missing required parameter: group');
    const paging = parsePaging(args);
    if (typeof paging === 'string') return error(paging);

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const groups = await listGroups(people);
      // Exact match only: a near-miss on a label used as a permission list must not pick another group.
      const group = groups.find((g) => g.resourceName === groupArg)
        ?? groups.find((g) => g.name === groupArg || g.formattedName === groupArg);
      if (!group?.resourceName) {
        const userLabels = groups.filter((g) => g.groupType !== 'SYSTEM_CONTACT_GROUP').map(groupLabel);
        return error(`No contact group named "${groupArg}". Labels: ${userLabels.length ? userLabels.map((l) => `"${l}"`).join(', ') : '(none)'}`);
      }

      const res = await people.contactGroups.get({ resourceName: group.resourceName, maxMembers: MAX_GROUP_MEMBERS });
      const memberNames = res.data.memberResourceNames ?? [];
      const { items: pageNames, next_page_token } = page(memberNames, paging.size, paging.offset);

      const found = new Map<string, people_v1.Schema$Person>();
      for (let i = 0; i < pageNames.length; i += BATCH_GET_LIMIT) {
        const batch = await people.people.getBatchGet({
          resourceNames: pageNames.slice(i, i + BATCH_GET_LIMIT),
          personFields: PERSON_FIELDS,
        });
        for (const r of batch.data.responses ?? []) {
          if (r.person && r.requestedResourceName) found.set(r.requestedResourceName, r.person);
        }
      }

      const names = groupNameMap(groups);
      const members = pageNames.filter((n) => found.has(n)).map((n) => toContact(found.get(n)!, names));
      return json({
        group: { name: groupLabel(group), resource_name: group.resourceName, member_count: res.data.memberCount ?? memberNames.length },
        members,
        count: members.length,
        next_page_token,
      });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'list contact group members');
    }
  });
}
