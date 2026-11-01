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
/** Reads work but writes fail with a scope error, like a token granted only contacts.readonly. */
let writeScopeMissing = false;
/** Every write request the server sent: method, path and body. */
const writes: Array<{ method: string; path: string; params: Record<string, unknown>; body: Record<string, unknown> }> = [];
/** batchGet answers these resource names with a per-person error instead of the person. */
const batchFailures = new Set<string>();
const requests: string[] = [];

function httpError(status: number, data: unknown, message: string): Error {
  return Object.assign(new Error(message), { response: { status, data, config: {}, headers: {} } });
}

function reply(opts: unknown, data: unknown) {
  return { status: 200, data, headers: {}, config: opts };
}

const scopeError = () => httpError(403, {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com' }],
  },
}, 'Request had insufficient authentication scopes.');

async function fakeTransport(opts: { url?: string; method?: string; params?: Record<string, unknown>; data?: unknown }) {
  const url = new URL(String(opts.url));
  const params = { ...Object.fromEntries(url.searchParams), ...(opts.params ?? {}) } as Record<string, unknown>;
  const method = (opts.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  requests.push(url.pathname);
  if (method !== 'GET') {
    const body = (typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data ?? {}) as Record<string, unknown>;
    if (writeScopeMissing) throw scopeError();
    writes.push({ method, path, params, body });
    if (path === '/v1/people:createContact') return reply(opts, { resourceName: 'people/new', etag: 'e0', ...body });
    const upd = path.match(/^\/v1\/(people\/[^/:]+):updateContact$/);
    if (upd) {
      if (body.etag !== 'etag-1') throw httpError(400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Request person.etag is different than the current person.etag.' } }, 'Request person.etag is different than the current person.etag.');
      return reply(opts, { ...people.find((x) => x.resourceName === upd[1]), ...body, etag: 'etag-2' });
    }
    if (/^\/v1\/people\/[^/:]+:deleteContact$/.test(path)) return reply(opts, {});
    if (path === '/v1/contactGroups') {
      const name = (body.contactGroup as { name: string }).name;
      return reply(opts, { resourceName: 'contactGroups/new', name, formattedName: name, groupType: 'USER_CONTACT_GROUP' });
    }
    if (/^\/v1\/contactGroups\/[^/]+\/members:modify$/.test(path)) {
      const known = new Set(people.map((x) => x.resourceName));
      const asked = [...(body.resourceNamesToAdd as string[] ?? []), ...(body.resourceNamesToRemove as string[] ?? [])];
      return reply(opts, { notFoundResourceNames: asked.filter((r) => !known.has(r)) });
    }
    throw httpError(404, { error: { code: 404 } }, `Unexpected ${method} ${path}`);
  }
  const one = path.match(/^\/v1\/(people\/c\d+)$/);
  if (one && !scopeMissing) {
    const person = people.find((x) => x.resourceName === one[1]);
    if (!person) throw httpError(404, { error: { code: 404, status: 'NOT_FOUND' } }, 'Requested entity was not found.');
    return reply(opts, { ...person, etag: 'etag-1' });
  }
  if (scopeMissing) {
    throw scopeError();
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
  writeScopeMissing = false;
  requests.length = 0;
  writes.length = 0;
  delete process.env.GOOGLE_CONTACTS_PROTECTED_LABELS;
  batchFailures.clear();
  for (const k of Object.keys(fullPeople)) delete fullPeople[k];
});

describe('contacts scope and tools', () => {
  it('requests the contacts scope, which covers reading and writing', () => {
    assert.ok(SCOPES.includes('https://www.googleapis.com/auth/contacts'));
    assert.ok(!SCOPES.includes('https://www.googleapis.com/auth/contacts.readonly'));
  });

  it('registers the read and write tools', () => {
    assert.deepEqual(tools.map((t) => t.name), [
      'google_contacts_search', 'google_contacts_list_groups', 'google_contacts_list_group_members',
      'google_contacts_create', 'google_contacts_update', 'google_contacts_delete',
      'google_contacts_create_label', 'google_contacts_update_label_members',
    ]);
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
      addresses: [],
      organizations: [],
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
      assert.match(text(res), /q@example\.com has not granted Google Contacts access \(contacts\)/, name);
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

describe('google_contacts_create', () => {
  it('creates a contact with every field and returns it', async () => {
    const res = data(await call('google_contacts_create', {
      given_name: ' Erin ', family_name: 'Ellis',
      emails: ['erin@example.com', { value: 'erin@work.example', type: 'work' }],
      phones: [{ value: '+1 555 000 1111', type: 'mobile' }],
      addresses: ['1 Main St\nSpringfield, IL'],
      organization: { company: 'Smile Dental', title: 'Office manager' },
      notes: 'Dentist office front desk.',
      labels: ['Family'],
    }));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/v1/people:createContact');
    assert.deepEqual(writes[0].body, {
      names: [{ givenName: 'Erin', familyName: 'Ellis' }],
      emailAddresses: [{ value: 'erin@example.com' }, { value: 'erin@work.example', type: 'work' }],
      phoneNumbers: [{ value: '+1 555 000 1111', type: 'mobile' }],
      addresses: [{ formattedValue: '1 Main St\nSpringfield, IL' }],
      organizations: [{ name: 'Smile Dental', title: 'Office manager' }],
      biographies: [{ value: 'Dentist office front desk.', contentType: 'TEXT_PLAIN' }],
      memberships: [
        { contactGroupMembership: { contactGroupResourceName: 'contactGroups/family' } },
        { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
      ],
    });
    assert.equal(res.contact.resource_name, 'people/new');
    assert.deepEqual(res.contact.organizations, [{ company: 'Smile Dental', title: 'Office manager' }]);
    assert.deepEqual(res.contact.groups, ['Family', 'My Contacts']);
  });

  it('refuses a protected label, in any letter case, and creates nothing', async () => {
    const res = await call('google_contacts_create', { given_name: 'Mallory', emails: ['m@evil.example'], labels: ['Solaris: trusted'] });
    assert.ok(res.isError);
    assert.match(text(res), /Can't add a new contact to "Solaris: trusted"\. Nothing was created\./);
    process.env.GOOGLE_CONTACTS_PROTECTED_LABELS = 'family';
    assert.match(text(await call('google_contacts_create', { given_name: 'Mallory', labels: ['Family'] })), /Can't add a new contact to "Family"/);
    assert.deepEqual(writes, []);
  });

  it('validates input before calling Google', async () => {
    assert.match(text(await call('google_contacts_create', {})), /at least a name, an email or a phone/);
    assert.match(text(await call('google_contacts_create', { emails: ['nope'] })), /not an email address/);
    assert.match(text(await call('google_contacts_create', { phones: ['x'] })), /not a phone number/);
    assert.match(text(await call('google_contacts_create', { emails: 'a@b.c' })), /must be a list/);
    assert.match(text(await call('google_contacts_create', { emails: Array(51).fill('a@b.c') })), /more than 50/);
    assert.match(text(await call('google_contacts_create', { given_name: 'A', organization: 'Acme' })), /organization must be an object/);
    assert.match(text(await call('google_contacts_create', { given_name: 'A', labels: 'Family' })), /labels must be a list/);
    assert.deepEqual(requests, []);
    assert.match(text(await call('google_contacts_create', { given_name: 'A', labels: ['Nope'] })), /No contact label named "Nope"\. Nothing was created\./);
    assert.deepEqual(writes, []);
  });
});

describe('google_contacts_update', () => {
  it('changes only the fields passed, with the current etag', async () => {
    const res = data(await call('google_contacts_update', { resource_name: 'people/c4', family_name: 'Dunn', notes: 'Neighbor.' }));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/v1/people/c4:updateContact');
    assert.equal(writes[0].params.updatePersonFields, 'names,biographies');
    assert.deepEqual(writes[0].body, {
      etag: 'etag-1',
      names: [{ givenName: '', familyName: 'Dunn' }],
      biographies: [{ value: 'Neighbor.', contentType: 'TEXT_PLAIN' }],
    });
    assert.deepEqual(res.contact.notes, ['Neighbor.']);
  });

  it('keeps the other name part', async () => {
    people[3].names = [{ displayName: 'Dan Doe', givenName: 'Dan', familyName: 'Doe', metadata: { primary: true } }];
    try {
      await call('google_contacts_update', { resource_name: 'people/c4', family_name: 'Dunn' });
      assert.deepEqual(writes[0].body.names, [{ givenName: 'Dan', familyName: 'Dunn' }]);
    } finally {
      people[3].names = [{ displayName: 'Dan Doe' }];
    }
  });

  it('replaces a list and clears notes with an empty string', async () => {
    await call('google_contacts_update', { resource_name: 'people/c4', emails: ['dan@example.com'], phones: [], notes: '' });
    assert.equal(writes[0].params.updatePersonFields, 'emailAddresses,phoneNumbers,biographies');
    assert.deepEqual(writes[0].body.phoneNumbers, []);
    assert.deepEqual(writes[0].body.biographies, []);
  });

  it('refuses to change the emails or phones of a contact on a protected label', async () => {
    for (const args of [{ emails: ['alice@new.example'] }, { phones: ['555 999 0000'] }, { emails: [], given_name: 'Al' }]) {
      const res = await call('google_contacts_update', { resource_name: 'people/c2', ...args });
      assert.ok(res.isError);
      assert.match(text(res), /on "Solaris: trusted", so its (emails|phones) can't be changed\. Nothing was saved\./);
      assert.match(text(res), /only the account owner changes them/);
    }
    assert.deepEqual(writes, []);
  });

  it('still edits names and notes of a contact on a protected label', async () => {
    data(await call('google_contacts_update', { resource_name: 'people/c2', notes: 'Kid\'s soccer coach.' }));
    assert.equal(writes[0].params.updatePersonFields, 'biographies');
  });

  it('honors GOOGLE_CONTACTS_PROTECTED_LABELS', async () => {
    process.env.GOOGLE_CONTACTS_PROTECTED_LABELS = '';
    data(await call('google_contacts_update', { resource_name: 'people/c2', emails: ['bob@new.example'] }));
    assert.equal(writes.length, 1);
    process.env.GOOGLE_CONTACTS_PROTECTED_LABELS = 'Other, family';
    assert.ok((await call('google_contacts_update', { resource_name: 'people/c1', phones: [] })).isError);
    assert.equal(writes.length, 1);
  });

  it('reports a contact changed in the meantime', async () => {
    const original = people[3];
    const proto = Object.getPrototypeOf(new google.auth.OAuth2().transporter);
    const stale = mock.method(proto, 'request', async (opts: { url?: string; method?: string }) => {
      const res = await fakeTransport(opts);
      if ((opts.method ?? 'GET') === 'GET' && String(opts.url).endsWith('/people/c4')) (res.data as { etag: string }).etag = 'old';
      return res;
    });
    try {
      const res = await call('google_contacts_update', { resource_name: 'people/c4', notes: 'x' });
      assert.ok(res.isError);
      assert.match(text(res), /changed while it was being updated, so nothing was saved/);
    } finally {
      stale.mock.restore();
      people[3] = original;
    }
  });

  it('validates input before calling Google', async () => {
    assert.match(text(await call('google_contacts_update', { resource_name: 'c4', notes: 'x' })), /resource_name/);
    assert.match(text(await call('google_contacts_update', { resource_name: 'people/c4' })), /Nothing to update/);
    assert.deepEqual(requests, []);
  });
});

describe('google_contacts_delete', () => {
  it('deletes a contact', async () => {
    const res = data(await call('google_contacts_delete', { resource_name: 'people/c4' }));
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ['DELETE /v1/people/c4:deleteContact']);
    assert.equal(res.deleted.resource_name, 'people/c4');
  });

  it('refuses to delete a contact on a protected label', async () => {
    const res = await call('google_contacts_delete', { resource_name: 'people/c3' });
    assert.match(text(res), /on "Solaris: trusted", so it can't be deleted/);
    assert.deepEqual(writes, []);
  });
});

describe('google_contacts_create_label', () => {
  it('creates a label', async () => {
    const res = data(await call('google_contacts_create_label', { name: ' Dentists ' }));
    assert.deepEqual(writes[0].body, { contactGroup: { name: 'Dentists' } });
    assert.deepEqual(res.label, { name: 'Dentists', resource_name: 'contactGroups/new' });
  });

  it('refuses a protected name in any letter case, and an existing name', async () => {
    for (const name of ['Solaris: trusted', ' SOLARIS: TRUSTED ']) {
      assert.match(text(await call('google_contacts_create_label', { name })), /Can't create a label named/);
    }
    assert.match(text(await call('google_contacts_create_label', { name: 'family' })), /already exists \(contactGroups\/family\)/);
    assert.deepEqual(writes, []);
  });
});

describe('google_contacts_update_label_members', () => {
  it('adds and removes members and reports unknown contacts', async () => {
    const res = data(await call('google_contacts_update_label_members', { label: 'Family', add: ['people/c4', 'people/zz'], remove: ['people/c1'] }));
    assert.equal(writes[0].path, '/v1/contactGroups/family/members:modify');
    assert.deepEqual(writes[0].body, { resourceNamesToAdd: ['people/c4', 'people/zz'], resourceNamesToRemove: ['people/c1'] });
    assert.deepEqual(res.added, ['people/c4']);
    assert.deepEqual(res.removed, ['people/c1']);
    assert.deepEqual(res.not_found, ['people/zz']);
  });

  it('refuses a protected label, by name or resource name', async () => {
    for (const label of ['Solaris: trusted', 'contactGroups/trusted']) {
      for (const change of [{ add: ['people/c4'] }, { remove: ['people/c2'] }]) {
        const res = await call('google_contacts_update_label_members', { label, ...change });
        assert.match(text(res), /Can't change who is on "Solaris: trusted"\. Nothing was changed\./);
      }
    }
    assert.deepEqual(writes, []);
  });

  it('validates input before changing anything', async () => {
    assert.match(text(await call('google_contacts_update_label_members', { label: 'Family' })), /add or remove/);
    assert.match(text(await call('google_contacts_update_label_members', { label: 'Family', add: ['c4'] })), /resource names/);
    assert.match(text(await call('google_contacts_update_label_members', { label: 'Family', add: ['people/c4'], remove: ['people/c4'] })), /In both add and remove/);
    assert.deepEqual(requests, []);
    assert.match(text(await call('google_contacts_update_label_members', { label: 'family', add: ['people/c4'] })), /No contact label named "family"/);
    assert.deepEqual(writes, []);
  });
});

describe('write scope missing', () => {
  it('tells the caller to sign in again to allow changes, for every write tool', async () => {
    writeScopeMissing = true;
    for (const [name, args] of [
      ['google_contacts_create', { given_name: 'A' }],
      ['google_contacts_update', { resource_name: 'people/c4', notes: 'x' }],
      ['google_contacts_delete', { resource_name: 'people/c4' }],
      ['google_contacts_create_label', { name: 'New' }],
      ['google_contacts_update_label_members', { label: 'Family', add: ['people/c4'] }],
    ] as const) {
      const res = await call(name, { ...args, account_email: 'q@example.com' });
      assert.ok(res.isError, name);
      assert.match(text(res), /q@example\.com has not granted permission to change Google Contacts \(contacts\)/, name);
      assert.match(text(res), /Sign in again to grant Contacts/, name);
    }
  });
});
