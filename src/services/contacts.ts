import { google, type people_v1 } from 'googleapis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse, GetAuthClient, OAuth2Client } from '../util/types.js';
import { ACCOUNT_EMAIL_DESCRIPTION } from '../util/account-docs.js';
import { accountForClient } from '../auth/accounts.js';

// Contact labels such as "Solaris: trusted" serve as permission lists, so the write tools never
// change a protected label (its members, its name, or whether it exists) or the emails and phones
// of a contact in one: those are how a sender is recognized as trusted. Only the account owner,
// in Google Contacts itself, can change who is trusted. See protectedLabels().

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,organizations,biographies,memberships';
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
  addresses: Array<{ value: string; type: string | null }>;
  organizations: Array<{ company: string | null; title: string | null }>;
  notes: string[];
  groups: string[];
}

/** Labels no write tool may touch. GOOGLE_CONTACTS_PROTECTED_LABELS (comma-separated) replaces the default. */
export function protectedLabels(): string[] {
  const env = process.env.GOOGLE_CONTACTS_PROTECTED_LABELS;
  if (env === undefined) return ['Solaris: trusted'];
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Case-insensitive, so a write can't create "solaris: Trusted" to stand in for the real label. */
function isProtectedName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  return !!n && protectedLabels().some((p) => p.toLowerCase() === n);
}

function isProtectedGroup(g: people_v1.Schema$ContactGroup): boolean {
  return isProtectedName(g.name) || isProtectedName(g.formattedName);
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

function isEtagMismatch(err: unknown): boolean {
  const e = err as GoogleError;
  const status = e?.response?.status ?? e?.status ?? Number(e?.code);
  return (status === 400 || status === 409) && /etag|FAILED_PRECONDITION/i.test(
    `${e?.message ?? ''} ${e?.response?.data?.error?.status ?? ''} ${e?.response?.data?.error?.message ?? ''}`,
  );
}

function describeError(err: unknown, auth: OAuth2Client, requested: string | undefined, action: string, write = false): ToolResponse {
  const acct = accountForClient(auth);
  const email = acct?.email ?? requested;
  if (isMissingScope(err)) {
    const who = email ?? 'This account';
    const client = acct ? ` with client "${acct.client}"` : '';
    const what = write
      ? 'permission to change Google Contacts (contacts); it was signed in when the server could only read contacts, or the permission was left unchecked'
      : 'Google Contacts access (contacts); it was signed in before the server asked for Contacts, or the permission was left unchecked';
    return error(
      `${who} has not granted ${what}. ` +
      `Sign in again to grant Contacts: run google_accounts_auth_start${client} and sign in as ${email ?? 'that account'}, ` +
      'then accept the Contacts permission on the consent screen.',
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (write && isEtagMismatch(err)) {
    return error(`The contact changed while it was being updated, so nothing was saved. Read it again and retry. ${msg}`);
  }
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
    addresses: (p.addresses ?? [])
      .filter((a) => a.formattedValue)
      .map((a) => ({ value: a.formattedValue!, type: a.formattedType || a.type || null })),
    organizations: (p.organizations ?? [])
      .filter((o) => o.name || o.title)
      .map((o) => ({ company: o.name || null, title: o.title || null })),
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

/** The API returns at most this many entries of a repeated field in list responses. */
const LIST_FIELD_LIMIT = 100;

interface BatchResult {
  found: Map<string, people_v1.Schema$Person>;
  failed: Array<{ resource_name: string; error: string }>;
}

/** Fetch people by resource name, keeping per-person failures instead of dropping them. */
async function getPeople(people: people_v1.People, resourceNames: string[]): Promise<BatchResult> {
  const found = new Map<string, people_v1.Schema$Person>();
  const failed: BatchResult['failed'] = [];
  for (let i = 0; i < resourceNames.length; i += BATCH_GET_LIMIT) {
    const requested = resourceNames.slice(i, i + BATCH_GET_LIMIT);
    const batch = await people.people.getBatchGet({ resourceNames: requested, personFields: PERSON_FIELDS });
    const seen = new Set<string>();
    for (const r of batch.data.responses ?? []) {
      const name = r.requestedResourceName;
      if (!name) continue;
      seen.add(name);
      const code = r.status?.code ?? 0;
      if (r.person && code === 0) found.set(name, r.person);
      else failed.push({ resource_name: name, error: r.status?.message || `status ${code || r.httpStatusCode || 'unknown'}` });
    }
    for (const name of requested) {
      if (!seen.has(name)) failed.push({ resource_name: name, error: 'not returned by the People API' });
    }
  }
  return { found, failed };
}

function maybeTruncated(p: people_v1.Schema$Person): boolean {
  return (p.emailAddresses?.length ?? 0) >= LIST_FIELD_LIMIT || (p.phoneNumbers?.length ?? 0) >= LIST_FIELD_LIMIT;
}

function page<T>(items: T[], size: number, offset: number): { items: T[]; next_page_token: string | null } {
  const slice = items.slice(offset, offset + size);
  const next = offset + size < items.length ? String(offset + size) : null;
  return { items: slice, next_page_token: next };
}

/** At most this many entries per field on a write, and contacts per label change. */
const MAX_WRITE_ITEMS = 50;
const MAX_MEMBER_CHANGES = 1000;
const NOTES_LIMIT = 20_000;

/** A write's contact fields, already in People API form. Only the fields the caller passed are set. */
interface ContactFields {
  names?: people_v1.Schema$Name[];
  emailAddresses?: people_v1.Schema$EmailAddress[];
  phoneNumbers?: people_v1.Schema$PhoneNumber[];
  addresses?: people_v1.Schema$Address[];
  organizations?: people_v1.Schema$Organization[];
  biographies?: people_v1.Schema$Biography[];
}

/** Fields that decide whether a sender is a given contact, and so whether they are trusted. */
const IDENTITY_FIELDS: Array<keyof ContactFields> = ['emailAddresses', 'phoneNumbers'];

function optString(args: Record<string, unknown>, key: string): string | undefined | Error {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return new Error(`${key} must be a string`);
  return v.trim();
}

/** A list of {value, type?} entries (or plain strings). Undefined when absent; an empty list clears the field. */
function valueList(args: Record<string, unknown>, key: string): Array<{ value: string; type?: string }> | undefined | Error {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return new Error(`${key} must be a list`);
  if (v.length > MAX_WRITE_ITEMS) return new Error(`${key} has more than ${MAX_WRITE_ITEMS} entries`);
  const out: Array<{ value: string; type?: string }> = [];
  for (const item of v) {
    const entry = typeof item === 'string' ? { value: item } : item as { value?: unknown; type?: unknown };
    if (!entry || typeof entry.value !== 'string' || !entry.value.trim()) return new Error(`each ${key} entry needs a non-empty value`);
    if (entry.type !== undefined && typeof entry.type !== 'string') return new Error(`${key} type must be a string`);
    out.push({ value: entry.value.trim(), ...(entry.type ? { type: entry.type.trim() } : {}) });
  }
  return out;
}

/**
 * Reads the contact fields of a create or update call. Names are given_name and family_name;
 * on an update, a name part left out keeps its current value (from `current`).
 */
export function parseContactFields(args: Record<string, unknown>, current?: people_v1.Schema$Person): ContactFields | string {
  const given = optString(args, 'given_name');
  const family = optString(args, 'family_name');
  const notes = optString(args, 'notes');
  for (const v of [given, family, notes]) if (v instanceof Error) return v.message;
  const emails = valueList(args, 'emails');
  const phones = valueList(args, 'phones');
  const addresses = valueList(args, 'addresses');
  for (const v of [emails, phones, addresses]) if (v instanceof Error) return v.message;

  const fields: ContactFields = {};
  if (given !== undefined || family !== undefined) {
    // A contact holds a single name, replaced as a whole, so start from the contact's own name
    // (not one from a linked Google profile) to keep its middle name, honorifics and phonetics.
    // The display forms are derived from the parts, so drop them.
    const strip = ({ metadata, displayName, displayNameLastFirst, unstructuredName, ...parts }: people_v1.Schema$Name) => parts;
    const own = current?.names?.find((n) => n.metadata?.source?.type === 'CONTACT');
    const merged = {
      ...(own ? strip(own) : {}),
      ...(given !== undefined ? { givenName: given as string } : {}),
      ...(family !== undefined ? { familyName: family as string } : {}),
    };
    fields.names = Object.values(merged).some((v) => v) ? [merged] : [];
  }
  if (emails) {
    for (const e of emails as Array<{ value: string }>) if (!e.value.includes('@')) return `"${e.value}" is not an email address`;
    fields.emailAddresses = (emails as Array<{ value: string; type?: string }>).map((e) => ({ value: e.value, type: e.type }));
  }
  if (phones) {
    for (const p of phones as Array<{ value: string }>) if (digits(p.value).length < 3) return `"${p.value}" is not a phone number`;
    fields.phoneNumbers = (phones as Array<{ value: string; type?: string }>).map((p) => ({ value: p.value, type: p.type }));
  }
  if (addresses) fields.addresses = (addresses as Array<{ value: string; type?: string }>).map((a) => ({ formattedValue: a.value, type: a.type }));

  const org = args.organization;
  if (org !== undefined && org !== null) {
    if (typeof org !== 'object' || Array.isArray(org)) return 'organization must be an object with company and/or title';
    const { company, title } = org as { company?: unknown; title?: unknown };
    if ((company !== undefined && typeof company !== 'string') || (title !== undefined && typeof title !== 'string')) {
      return 'organization company and title must be strings';
    }
    const c = (company as string | undefined)?.trim() ?? '';
    const t = (title as string | undefined)?.trim() ?? '';
    fields.organizations = c || t ? [{ name: c || undefined, title: t || undefined }] : [];
  }
  if (notes !== undefined) {
    if ((notes as string).length > NOTES_LIMIT) return `notes is longer than ${NOTES_LIMIT} characters`;
    fields.biographies = notes ? [{ value: notes as string, contentType: 'TEXT_PLAIN' }] : [];
  }
  return fields;
}

function protectedMembership(p: people_v1.Schema$Person, groups: people_v1.Schema$ContactGroup[]): string | null {
  const isProtected = new Set(groups.filter(isProtectedGroup).map((g) => g.resourceName));
  for (const m of p.memberships ?? []) {
    const r = m.contactGroupMembership?.contactGroupResourceName;
    if (r && isProtected.has(r)) return groupLabel(groups.find((g) => g.resourceName === r)!);
  }
  return null;
}

function findGroup(groups: people_v1.Schema$ContactGroup[], arg: string): people_v1.Schema$ContactGroup | undefined {
  return groups.find((g) => g.resourceName === arg) ?? groups.find((g) => g.name === arg || g.formattedName === arg);
}

function resourceNameList(args: Record<string, unknown>, key: string): string[] | string {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !/^people\/[\w-]+$/.test(x))) {
    return `${key} must be a list of contact resource names (people/...)`;
  }
  return [...new Set(v as string[])];
}

const RESOURCE_NAME = { type: 'string', description: 'Contact resource name (people/...), from google_contacts_search' };
const VALUE_LIST = (what: string) => ({
  type: 'array',
  description: `${what}: a list of {value, type?} (type e.g. home, work, mobile) or plain strings`,
  items: {
    anyOf: [
      { type: 'string' },
      { type: 'object', properties: { value: { type: 'string' }, type: { type: 'string' } }, required: ['value'] },
    ],
  },
});
const CONTACT_FIELD_PROPS = {
  given_name: { type: 'string', description: 'First name' },
  family_name: { type: 'string', description: 'Last name' },
  emails: VALUE_LIST('Email addresses'),
  phones: VALUE_LIST('Phone numbers'),
  addresses: VALUE_LIST('Postal addresses, each as one line or several lines'),
  organization: {
    type: 'object',
    description: 'Company and job title',
    properties: { company: { type: 'string' }, title: { type: 'string' } },
  },
  notes: { type: 'string', description: 'The contact\'s notes' },
};

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
  {
    name: 'google_contacts_create',
    description:
      'Create a Google contact. Give at least a name, an email or a phone. labels adds it to existing contact groups by exact name; ' +
      'protected labels (e.g. "Solaris: trusted") are refused, since only the account owner decides who is on them. Returns the new contact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...CONTACT_FIELD_PROPS,
        labels: { type: 'array', items: { type: 'string' }, description: 'Existing label names (or contactGroups/... resource names) to add the contact to' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: 'google_contacts_update',
    description:
      'Update a Google contact. Only the fields you pass change; a list field you pass (emails, phones, addresses) replaces the whole list, ' +
      'so include the entries to keep, and an empty list or empty notes clears it. given_name and family_name change independently. ' +
      'The emails and phones of a contact on a protected label (e.g. "Solaris: trusted") cannot be changed: they decide who is trusted, ' +
      'so ask the account owner to change them in Google Contacts. Returns the updated contact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        resource_name: RESOURCE_NAME,
        ...CONTACT_FIELD_PROPS,
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['resource_name'],
    },
  },
  {
    name: 'google_contacts_delete',
    description: 'Delete a Google contact. A contact on a protected label (e.g. "Solaris: trusted") cannot be deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        resource_name: RESOURCE_NAME,
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['resource_name'],
    },
  },
  {
    name: 'google_contacts_create_label',
    description: 'Create a Google Contacts label (contact group). A protected label name (e.g. "Solaris: trusted", in any letter case) is refused.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Label name' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['name'],
    },
  },
  {
    name: 'google_contacts_update_label_members',
    description:
      'Add contacts to or remove them from a Google Contacts label (contact group), by exact label name or resource name. ' +
      'Protected labels (e.g. "Solaris: trusted") are refused: only the account owner changes who is on them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        label: { type: 'string', description: 'Label name exactly as shown in Google Contacts, or its resource name (contactGroups/...)' },
        add: { type: 'array', items: { type: 'string' }, description: 'Contact resource names (people/...) to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Contact resource names (people/...) to remove' },
        account_email: { type: 'string', description: ACCOUNT_EMAIL_DESCRIPTION },
      },
      required: ['label'],
    },
  },
];

const protectedRefusal = (what: string) =>
  error(`${what} Protected labels (${protectedLabels().map((l) => `"${l}"`).join(', ')}) decide who is trusted; only the account owner changes them, in Google Contacts.`);

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
      // List responses cap repeated fields, so re-read any contact that may have been cut short.
      const truncated = scan.people.filter((p) => p.resourceName && maybeTruncated(p)).map((p) => p.resourceName!);
      let failed: BatchResult['failed'] = [];
      if (truncated.length) {
        const full = await getPeople(people, truncated);
        failed = full.failed;
        scan.people = scan.people.map((p) => full.found.get(p.resourceName ?? '') ?? p);
      }
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
        ...(failed.length ? { failed_contacts: failed } : {}),
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

      const { found, failed } = await getPeople(people, pageNames);

      const names = groupNameMap(groups);
      const members = pageNames.filter((n) => found.has(n)).map((n) => toContact(found.get(n)!, names));
      return json({
        group: { name: groupLabel(group), resource_name: group.resourceName, member_count: res.data.memberCount ?? memberNames.length },
        members,
        count: members.length,
        next_page_token,
        ...(failed.length ? {
          failed_members: failed,
          warning: `${failed.length} member(s) of this group could not be read and are not in members; do not treat them as absent from the group.`,
        } : {}),
      });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'list contact group members');
    }
  });

  handleCall('google_contacts_create', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const fields = parseContactFields(args);
    if (typeof fields === 'string') return error(fields);
    if (!fields.names?.length && !fields.emailAddresses?.length && !fields.phoneNumbers?.length) {
      return error('Give at least a name, an email or a phone');
    }
    const labelArgs = args.labels ?? [];
    if (!Array.isArray(labelArgs) || labelArgs.some((l) => typeof l !== 'string' || !l.trim())) return error('labels must be a list of label names');

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const groups = await listGroups(people);
      const memberships = new Set<string>();
      for (const l of labelArgs as string[]) {
        const g = findGroup(groups, l.trim());
        if (!g?.resourceName) return error(`No contact label named "${l}". Nothing was created.`);
        if (isProtectedGroup(g)) return protectedRefusal(`Can't add a new contact to "${groupLabel(g)}". Nothing was created.`);
        memberships.add(g.resourceName);
      }
      // Every new contact lands in My Contacts (named memberships replace the default, so add it back).
      const myContacts = groups.find((g) => g.resourceName === 'contactGroups/myContacts');
      if (myContacts && isProtectedGroup(myContacts)) {
        return protectedRefusal(`A new contact always joins "${groupLabel(myContacts)}". Nothing was created.`);
      }
      if (memberships.size) memberships.add('contactGroups/myContacts');
      const res = await people.people.createContact({
        personFields: PERSON_FIELDS,
        requestBody: {
          ...fields,
          ...(memberships.size ? { memberships: [...memberships].map((r) => ({ contactGroupMembership: { contactGroupResourceName: r } })) } : {}),
        },
      });
      return json({ contact: toContact(res.data, groupNameMap(groups)) });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'create the contact', true);
    }
  });

  handleCall('google_contacts_update', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const resourceName = typeof args.resource_name === 'string' ? args.resource_name.trim() : '';
    if (!/^people\/[\w-]+$/.test(resourceName)) return error('resource_name must be a contact resource name (people/...)');
    const precheck = parseContactFields(args);
    if (typeof precheck === 'string') return error(precheck);
    if (!Object.keys(precheck).length) return error('Nothing to update: pass at least one contact field');

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const [groups, current] = await Promise.all([
        listGroups(people),
        people.people.get({ resourceName, personFields: `${PERSON_FIELDS},metadata` }),
      ]);
      const fields = parseContactFields(args, current.data) as ContactFields;
      const label = protectedMembership(current.data, groups);
      const identity = IDENTITY_FIELDS.filter((f) => f in fields);
      if (label && identity.length) {
        return protectedRefusal(
          `This contact is on "${label}", so its ${identity.map((f) => (f === 'emailAddresses' ? 'emails' : 'phones')).join(' and ')} can't be changed. Nothing was saved.`,
        );
      }
      const res = await people.people.updateContact({
        resourceName,
        updatePersonFields: Object.keys(fields).join(','),
        personFields: PERSON_FIELDS,
        // The People API requires the contact's source (with its etag) alongside the person etag.
        requestBody: {
          etag: current.data.etag,
          metadata: { sources: (current.data.metadata?.sources ?? []).filter((src) => src.type === 'CONTACT') },
          ...fields,
        },
      });
      return json({ contact: toContact(res.data, groupNameMap(groups)) });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'update the contact', true);
    }
  });

  handleCall('google_contacts_delete', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const resourceName = typeof args.resource_name === 'string' ? args.resource_name.trim() : '';
    if (!/^people\/[\w-]+$/.test(resourceName)) return error('resource_name must be a contact resource name (people/...)');

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const [groups, current] = await Promise.all([
        listGroups(people),
        people.people.get({ resourceName, personFields: PERSON_FIELDS }),
      ]);
      const label = protectedMembership(current.data, groups);
      if (label) return protectedRefusal(`This contact is on "${label}", so it can't be deleted. Nothing was deleted.`);
      await people.people.deleteContact({ resourceName });
      return json({ deleted: toContact(current.data, groupNameMap(groups)) });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'delete the contact', true);
    }
  });

  handleCall('google_contacts_create_label', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return error('Missing required parameter: name');
    if (isProtectedName(name)) return protectedRefusal(`Can't create a label named "${name}".`);

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const groups = await listGroups(people);
      const existing = groups.find((g) => groupLabel(g).toLowerCase() === name.toLowerCase());
      if (existing) return error(`A label named "${groupLabel(existing)}" already exists (${existing.resourceName}).`);
      const res = await people.contactGroups.create({ requestBody: { contactGroup: { name } } });
      return json({ label: { name: groupLabel(res.data), resource_name: res.data.resourceName } });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'create the label', true);
    }
  });

  handleCall('google_contacts_update_label_members', async (args) => {
    const accountEmail = args.account_email as string | undefined;
    const labelArg = typeof args.label === 'string' ? args.label.trim() : '';
    if (!labelArg) return error('Missing required parameter: label');
    const add = resourceNameList(args, 'add');
    const remove = resourceNameList(args, 'remove');
    if (typeof add === 'string') return error(add);
    if (typeof remove === 'string') return error(remove);
    if (!add.length && !remove.length) return error('Pass contacts to add or remove');
    if (add.length + remove.length > MAX_MEMBER_CHANGES) return error(`At most ${MAX_MEMBER_CHANGES} contacts per call`);
    const both = add.filter((r) => remove.includes(r));
    if (both.length) return error(`In both add and remove: ${both.join(', ')}`);

    const auth = await getAuth(accountEmail);
    const people = google.people({ version: 'v1', auth });
    try {
      const groups = await listGroups(people);
      const group = findGroup(groups, labelArg);
      if (!group?.resourceName) {
        const userLabels = groups.filter((g) => g.groupType !== 'SYSTEM_CONTACT_GROUP').map(groupLabel);
        return error(`No contact label named "${labelArg}". Labels: ${userLabels.length ? userLabels.map((l) => `"${l}"`).join(', ') : '(none)'}`);
      }
      if (isProtectedGroup(group)) return protectedRefusal(`Can't change who is on "${groupLabel(group)}". Nothing was changed.`);
      const res = await people.contactGroups.members.modify({
        resourceName: group.resourceName,
        requestBody: { resourceNamesToAdd: add, resourceNamesToRemove: remove },
      });
      const notFound = res.data.notFoundResourceNames ?? [];
      const lastGroup = res.data.canNotRemoveLastContactGroupResourceNames ?? [];
      return json({
        label: { name: groupLabel(group), resource_name: group.resourceName },
        added: add.filter((r) => !notFound.includes(r)),
        removed: remove.filter((r) => !notFound.includes(r) && !lastGroup.includes(r)),
        ...(notFound.length ? { not_found: notFound } : {}),
        ...(lastGroup.length ? { not_removed_last_label: lastGroup } : {}),
      });
    } catch (err) {
      return describeError(err, auth, accountEmail, 'change the label\'s members', true);
    }
  });
}
