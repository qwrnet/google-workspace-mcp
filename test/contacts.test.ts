import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { google } from 'googleapis';
import { register, tools, phoneMatches, isMissingScope } from '../src/services/contacts.js';
import { SCOPES } from '../src/auth/oauth.js';
import type { ToolResponse } from '../src/util/types.js';

const groups = [
  { resourceName: 'contactGroups/myContacts', name: 'myContacts', formattedName: 'My Contacts', groupType: 'SYSTEM_CONTACT_GROUP', memberCount: 4 },
  { resourceName: 'contactGroups/trusted', name: 'Solaris: trusted', formattedName: 'Solaris: trusted', groupType: 'USER_CONTACT_GROUP', memberCount: 3 },
  { resourceName: 'contactGroups/family', name: 'Family', formattedName: 'Family', groupType: 'USER_CONTACT_GROUP', memberCount: 1 },
];

const mem = (...ids: string[]) => ids.map((id) => ({ contactGroupMembership: { contactGroupResourceName: `contactGroups/${id}` } }));

const people: Record<string, unknown>[] = [
  {
    resourceName: 'people/c1',
    names: [{ displayName: 'Alice Archer' }],
    emailAddresses: [{ value: 'alice@example.com', type: 'home', formattedType: 'Home' }, { value: 'Alice.Work@Example.org' }],
    phoneNumbers: [{ value: '(555) 123-4567', canonicalForm: '+15551234567', type: 'mobile', formattedType: 'Mobile' }],
    biographies: [{ value: 'Sister. Can approve purchases.' }],
    memberships: mem('myContacts', 'trusted', 'family'),
  },
  {
    resourceName: 'people/c2',
    names: [{ displayName: 'Bob Baker' }],
    emailAddresses: [{ value: 'bob@example.com' }],
    phoneNumbers: [{ value: '+44 7700 900123', canonicalForm: '+447700900123' }],
    memberships: mem('myContacts', 'trusted'),
  },
  {
    resourceName: 'people/c3',
    names: [{ displayName: 'Carol Alison' }],
    emailAddresses: [{ value: 'carol@example.net' }],
    memberships: mem('myContacts', 'trusted'),
  },
  {
    resourceName: 'people/c4',
    names: [{ displayName: 'Dan Doe' }],
    phoneNumbers: [{ value: '555-123-4567' }],
    memberships: mem('myContacts'),
  },
];

/** What batchGet returns where the list response would be cut short. */
const fullPeople: Record<string, Record<string, unknown>> = {};

let scopeMissing = false;
/** batchGet answers these resource names with a per-person error instead of the person. */
const batchFailures = new Set<string>();
const requests: string[] = [];

function httpError(status: number, data: unknown, message: string): Error {
  return Object.assign(new Error(message), { response: { status, data, config: {}, headers: {} } });
}

function reply(opts: unknown, data: unknown) {
  return { status: 200, data, headers: {}, config: opts };
}

async function fakeTransport(opts: { url?: string; params?: Record<string, unknown> }) {
  const url = new URL(String(opts.url));
  const params = { ...Object.fromEntries(url.searchParams), ...(opts.params ?? {}) } as Record<string, unknown>;
  requests.push(url.pathname);
  if (scopeMissing) {
    throw httpError(403, {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com' }],
      },
    }, 'Request had insufficient authentication scopes.');
  }
  if (url.pathname === '/v1/people/me/connections') {
    // Two pages of two, so the scan has to follow nextPageToken.
    const start = params.pageToken === 'p2' ? 2 : 0;
    return reply(opts, { connections: people.slice(start, start + 2), nextPageToken: start === 0 ? 'p2' : undefined });
  }
  if (url.pathname === '/v1/contactGroups') return reply(opts, { contactGroups: groups });
  const g = url.pathname.match(/^\/v1\/(contactGroups\/[^/]+)$/);
  if (g) {
    const group = groups.find((x) => x.resourceName === decodeURIComponent(g[1]));
    if (!group) throw httpError(404, { error: { code: 404 } }, 'Not found');
    const members = people
      .filter((p) => (p.memberships as ReturnType<typeof mem>).some((m) => m.contactGroupMembership.contactGroupResourceName === group.resourceName))
      .map((p) => p.resourceName);
    return reply(opts, { ...group, memberResourceNames: members });
  }
  if (url.pathname === '/v1/people:batchGet') {
    const names = ([] as unknown[]).concat(params.resourceNames ?? url.searchParams.getAll('resourceNames')) as string[];
    return reply(opts, {
      responses: names.map((n) => batchFailures.has(n)
        ? { requestedResourceName: n, httpStatusCode: 403, status: { code: 7, message: 'Permission denied' } }
        : { requestedResourceName: n, person: fullPeople[n] ?? people.find((p) => p.resourceName === n) }),
    });
  }
  throw httpError(404, { error: { code: 404 } }, `Unexpected request ${url.pathname}`);
}

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResponse>>();
const call = (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!(args);
const text = (r: ToolResponse) => (r.content[0] as { text: string }).text;
const data = (r: ToolResponse) => {
  assert.ok(!r.isError, text(r));
  return JSON.parse(text(r));
};

before(() => {
  const proto = Object.getPrototypeOf(new google.auth.OAuth2().transporter);
  mock.method(proto, 'request', fakeTransport);
  const auth = new google.auth.OAuth2('id', 'secret');
  auth.setCredentials({ access_token: 'at', expiry_date: Date.now() + 3600_000 });
  register((name, fn) => handlers.set(name, fn), async () => auth);
});

after(() => mock.restoreAll());

beforeEach(() => {
  scopeMissing = false;
  requests.length = 0;
  batchFailures.clear();
  for (const k of Object.keys(fullPeople)) delete fullPeople[k];
});

describe('contacts scope and tools', () => {
  it('requests contacts.readonly and no Contacts write scope', () => {
    assert.ok(SCOPES.includes('https://www.googleapis.com/auth/contacts.readonly'));
    assert.ok(!SCOPES.some((s) => /\/auth\/contacts(\.other)?$/.test(s) || s.endsWith('/auth/contacts.other.readonly')));
  });

  it('registers only read tools', () => {
    assert.deepEqual(tools.map((t) => t.name), ['google_contacts_search', 'google_contacts_list_groups', 'google_contacts_list_group_members']);
    assert.deepEqual([...handlers.keys()], tools.map((t) => t.name));
  });
});

describe('google_contacts_search', () => {
  it('finds a contact by any of its emails, case-insensitively, with all fields', async () => {
    const res = data(await call('google_contacts_search', { email: ' alice.work@EXAMPLE.org ' }));
    assert.equal(res.count, 1);
    assert.deepEqual(res.contacts[0], {
      resource_name: 'people/c1',
      names: ['Alice Archer'],
      emails: [{ value: 'alice@example.com', type: 'Home' }, { value: 'Alice.Work@Example.org', type: null }],
      phones: [{ value: '(555) 123-4567', canonical: '+15551234567', type: 'Mobile' }],
      notes: ['Sister. Can approve purchases.'],
      groups: ['My Contacts', 'Solaris: trusted', 'Family'],
    });
    assert.equal(res.next_page_token, null);
  });

  it('matches email exactly, not as a substring', async () => {
    assert.equal(data(await call('google_contacts_search', { email: 'lice@example.com' })).count, 0);
  });

  it('finds a contact on a later page of the contact list', async () => {
    const res = data(await call('google_contacts_search', { email: 'carol@example.net' }));
    assert.deepEqual(res.contacts.map((c: { resource_name: string }) => c.resource_name), ['people/c3']);
  });

  it('matches phone numbers across formats, with and without +1', async () => {
    for (const phone of ['+1 555 123 4567', '555.123.4567', '15551234567']) {
      const res = data(await call('google_contacts_search', { phone }));
      assert.deepEqual(res.contacts.map((c: { resource_name: string }) => c.resource_name), ['people/c1', 'people/c4'], phone);
    }
    const uk = data(await call('google_contacts_search', { phone: '+447700900123' }));
    assert.deepEqual(uk.contacts.map((c: { resource_name: string }) => c.resource_name), ['people/c2']);
    assert.equal(data(await call('google_contacts_search', { phone: '5551234' })).count, 0);
  });

  it('searches names and emails by substring with a query, and paginates', async () => {
    const first = data(await call('google_contacts_search', { query: 'ali', page_size: 1 }));
    assert.equal(first.total_matches, 2);
    assert.deepEqual(first.contacts.map((c: { names: string[] }) => c.names[0]), ['Alice Archer']);
    assert.equal(first.next_page_token, '1');
    const second = data(await call('google_contacts_search', { query: 'ali', page_size: 1, page_token: first.next_page_token }));
    assert.deepEqual(second.contacts.map((c: { names: string[] }) => c.names[0]), ['Carol Alison']);
    assert.equal(second.next_page_token, null);
  });

  it('re-reads a contact whose email list may have been cut short by the list response', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ value: `old${i}@example.com` }));
    const original = people[3].emailAddresses;
    people[3].emailAddresses = many;
    fullPeople['people/c4'] = { ...people[3], emailAddresses: [...many, { value: 'dan.latest@example.com' }] };
    try {
      const res = data(await call('google_contacts_search', { email: 'dan.latest@example.com' }));
      assert.deepEqual(res.contacts.map((c: { resource_name: string }) => c.resource_name), ['people/c4']);
      assert.equal(res.contacts[0].emails.length, 101);
      assert.ok(requests.includes('/v1/people:batchGet'));
    } finally {
      people[3].emailAddresses = original;
    }
  });

  it('bounds page_size', async () => {
    const res = data(await call('google_contacts_search', { query: 'example', page_size: 10_000 }));
    assert.equal(res.count, 3);
  });

  it('rejects zero or several search terms and bad paging before calling Google', async () => {
    assert.match(text(await call('google_contacts_search', {})), /exactly one/);
    assert.match(text(await call('google_contacts_search', { email: 'a@b.c', phone: '555' })), /exactly one/);
    assert.match(text(await call('google_contacts_search', { email: 'nobody' })), /email address/);
    assert.match(text(await call('google_contacts_search', { phone: 'abc' })), /digits/);
    assert.match(text(await call('google_contacts_search', { query: 'a', page_token: 'xyz' })), /page_token/);
    assert.match(text(await call('google_contacts_search', { query: 'a', page_size: 0 })), /page_size/);
    assert.deepEqual(requests, []);
  });
});

describe('google_contacts_list_groups', () => {
  it('lists system and user labels with member counts', async () => {
    const res = data(await call('google_contacts_list_groups'));
    assert.deepEqual(res.groups, [
      { name: 'My Contacts', resource_name: 'contactGroups/myContacts', type: 'system', member_count: 4 },
      { name: 'Solaris: trusted', resource_name: 'contactGroups/trusted', type: 'user', member_count: 3 },
      { name: 'Family', resource_name: 'contactGroups/family', type: 'user', member_count: 1 },
    ]);
  });
});

describe('google_contacts_list_group_members', () => {
  it('lists the members of a label by name, paginated', async () => {
    const first = data(await call('google_contacts_list_group_members', { group: 'Solaris: trusted', page_size: 2 }));
    assert.deepEqual(first.group, { name: 'Solaris: trusted', resource_name: 'contactGroups/trusted', member_count: 3 });
    assert.deepEqual(first.members.map((m: { resource_name: string }) => m.resource_name), ['people/c1', 'people/c2']);
    assert.deepEqual(first.members[1].phones, [{ value: '+44 7700 900123', canonical: '+447700900123', type: null }]);
    assert.equal(first.next_page_token, '2');
    const second = data(await call('google_contacts_list_group_members', { group: 'Solaris: trusted', page_size: 2, page_token: '2' }));
    assert.deepEqual(second.members.map((m: { resource_name: string }) => m.resource_name), ['people/c3']);
    assert.deepEqual(second.members[0].groups, ['My Contacts', 'Solaris: trusted']);
    assert.equal(second.next_page_token, null);
  });

  it('reports members that could not be read instead of dropping them', async () => {
    batchFailures.add('people/c2');
    const res = data(await call('google_contacts_list_group_members', { group: 'Solaris: trusted' }));
    assert.deepEqual(res.members.map((m: { resource_name: string }) => m.resource_name), ['people/c1', 'people/c3']);
    assert.deepEqual(res.failed_members, [{ resource_name: 'people/c2', error: 'Permission denied' }]);
    assert.match(res.warning, /could not be read/);
  });

  it('accepts a resource name', async () => {
    const res = data(await call('google_contacts_list_group_members', { group: 'contactGroups/family' }));
    assert.deepEqual(res.members.map((m: { names: string[] }) => m.names[0]), ['Alice Archer']);
  });

  it('requires an exact label name and lists the labels when it is not found', async () => {
    const res = await call('google_contacts_list_group_members', { group: 'solaris: Trusted' });
    assert.ok(res.isError);
    assert.match(text(res), /No contact group named "solaris: Trusted"\. Labels: "Solaris: trusted", "Family"/);
  });
});

describe('missing Contacts scope', () => {
  it('tells the caller to sign in again to grant Contacts, for every tool', async () => {
    scopeMissing = true;
    for (const [name, args] of [
      ['google_contacts_search', { email: 'alice@example.com', account_email: 'q@example.com' }],
      ['google_contacts_list_groups', { account_email: 'q@example.com' }],
      ['google_contacts_list_group_members', { group: 'Solaris: trusted', account_email: 'q@example.com' }],
    ] as const) {
      const res = await call(name, args);
      assert.ok(res.isError, name);
      assert.match(text(res), /q@example\.com has not granted Google Contacts access/, name);
      assert.match(text(res), /Sign in again to grant Contacts: run google_accounts_auth_start/, name);
      assert.doesNotMatch(text(res), /insufficient authentication scopes/, name);
    }
  });

  it('recognizes the scope error shapes Google returns, and nothing else', () => {
    const e = (status: number, data: unknown, message = '') => httpError(status, data, message);
    assert.ok(isMissingScope(e(403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } })));
    assert.ok(isMissingScope(e(403, { error: { message: 'Request had insufficient authentication scopes.' } })));
    assert.ok(isMissingScope(e(403, { error: { errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }] } }, 'Insufficient Permission')));
    assert.ok(!isMissingScope(e(403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 'People API has not been used in project 1')));
    assert.ok(!isMissingScope(e(401, { error: { message: 'insufficient authentication scopes' } })));
    assert.ok(!isMissingScope(new Error('boom')));
  });

  it('reports a disabled People API clearly', async () => {
    const auth = new google.auth.OAuth2('id', 'secret');
    auth.setCredentials({ access_token: 'at', expiry_date: Date.now() + 3600_000 });
    const local = new Map<string, (args: Record<string, unknown>) => Promise<ToolResponse>>();
    register((name, fn) => local.set(name, fn), async () => auth);
    const disabled = mock.method(Object.getPrototypeOf(auth.transporter), 'request', async () => {
      throw httpError(403, { error: { code: 403, details: [{ reason: 'SERVICE_DISABLED' }] } }, 'People API has not been used in project 123 before or it is disabled.');
    });
    try {
      const res = await local.get('google_contacts_list_groups')!({});
      assert.ok(res.isError);
      assert.match(text(res), /People API is not enabled/);
    } finally {
      disabled.mock.restore();
    }
  });
});

describe('phoneMatches', () => {
  it('compares digits of the typed and canonical forms', () => {
    assert.ok(phoneMatches('5551234567', { value: '+1 (555) 123-4567' }));
    assert.ok(phoneMatches('15551234567', { value: '555 123 4567' }));
    assert.ok(phoneMatches('447700900123', { value: '07700 900123', canonicalForm: '+447700900123' }));
    assert.ok(!phoneMatches('7700900123', { value: '07700 900123', canonicalForm: '+447700900123' }));
    assert.ok(!phoneMatches('5551234567', { value: '' }));
  });
});
