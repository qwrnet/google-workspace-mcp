import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { google } from 'googleapis';
import { buildSharePermission, register, tools } from '../src/services/drive.js';
import type { ToolResponse } from '../src/util/types.js';

/** Every request the server sent: method, path, query params and body. */
const sent: Array<{ method: string; path: string; params: Record<string, unknown>; body: Record<string, unknown> }> = [];

function reply(opts: unknown, data: unknown) {
  return { status: 200, data, headers: {}, config: opts };
}

async function fakeTransport(opts: { url?: string; method?: string; params?: Record<string, unknown>; data?: unknown }) {
  const url = new URL(String(opts.url));
  const params = { ...Object.fromEntries(url.searchParams), ...(opts.params ?? {}) } as Record<string, unknown>;
  const method = (opts.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const body = (typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data ?? {}) as Record<string, unknown>;
  sent.push({ method, path, params, body });
  if (method === 'POST' && /^\/drive\/v3\/files\/[^/]+\/permissions$/.test(path)) {
    return reply(opts, { id: 'perm-1', ...body });
  }
  throw Object.assign(new Error(`Unexpected ${method} ${path}`), { response: { status: 404, data: {}, config: {}, headers: {} } });
}

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResponse>>();
const call = (args: Record<string, unknown>) => handlers.get('google_drive_share')!(args);
const text = (r: ToolResponse) => (r.content[0] as { text: string }).text;

before(() => {
  const proto = Object.getPrototypeOf(new google.auth.OAuth2().transporter);
  mock.method(proto, 'request', fakeTransport);
  const auth = new google.auth.OAuth2('id', 'secret');
  auth.setCredentials({ access_token: 'at', expiry_date: Date.now() + 3600_000 });
  register((name, fn) => handlers.set(name, fn), async () => auth);
});

after(() => mock.restoreAll());

beforeEach(() => {
  sent.length = 0;
});

describe('google_drive_share schema', () => {
  const tool = tools.find((t) => t.name === 'google_drive_share')!;
  const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;

  it('requires only file_id and role', () => {
    assert.deepEqual(tool.inputSchema.required, ['file_id', 'role']);
  });

  it('offers every permission type and the type-specific params', () => {
    assert.deepEqual(props.type.enum, ['user', 'group', 'domain', 'anyone']);
    for (const key of ['email', 'domain', 'allow_file_discovery', 'send_notification']) assert.ok(props[key], key);
  });
});

describe('buildSharePermission', () => {
  it('defaults to a user share with no notification email', () => {
    assert.deepEqual(buildSharePermission({ role: 'writer', email: 'a@example.com' }), {
      requestBody: { role: 'writer', type: 'user', emailAddress: 'a@example.com' },
      sendNotificationEmail: false,
    });
  });

  it('builds a group share and passes send_notification through', () => {
    assert.deepEqual(buildSharePermission({ role: 'reader', type: 'group', email: 'team@example.com', send_notification: true }), {
      requestBody: { role: 'reader', type: 'group', emailAddress: 'team@example.com' },
      sendNotificationEmail: true,
    });
  });

  it('builds a domain share with domain and no email', () => {
    assert.deepEqual(buildSharePermission({ role: 'commenter', type: 'domain', domain: 'example.com' }), {
      requestBody: { role: 'commenter', type: 'domain', domain: 'example.com', allowFileDiscovery: false },
    });
  });

  it('builds an anyone-with-the-link share with neither email nor domain', () => {
    assert.deepEqual(buildSharePermission({ role: 'reader', type: 'anyone' }), {
      requestBody: { role: 'reader', type: 'anyone', allowFileDiscovery: false },
    });
    assert.deepEqual(buildSharePermission({ role: 'reader', type: 'anyone', allow_file_discovery: true }), {
      requestBody: { role: 'reader', type: 'anyone', allowFileDiscovery: true },
    });
  });

  const rejects: Array<[string, Record<string, unknown>, RegExp]> = [
    ['user without email', { role: 'reader' }, /email/],
    ['user with blank email', { role: 'reader', email: '  ' }, /email/],
    ['group without email', { role: 'reader', type: 'group' }, /email/],
    ['user with domain', { role: 'reader', email: 'a@example.com', domain: 'example.com' }, /domain/],
    ['user with allow_file_discovery', { role: 'reader', email: 'a@example.com', allow_file_discovery: true }, /allow_file_discovery/],
    ['domain without domain', { role: 'reader', type: 'domain' }, /domain/],
    ['domain with email', { role: 'reader', type: 'domain', domain: 'example.com', email: 'a@example.com' }, /email/],
    ['domain with send_notification', { role: 'reader', type: 'domain', domain: 'example.com', send_notification: true }, /send_notification/],
    ['anyone with email', { role: 'reader', type: 'anyone', email: 'a@example.com' }, /email/],
    ['anyone with domain', { role: 'reader', type: 'anyone', domain: 'example.com' }, /domain/],
    ['anyone with send_notification', { role: 'reader', type: 'anyone', send_notification: false }, /send_notification/],
    ['unknown type', { role: 'reader', type: 'everyone' }, /type must be one of/],
    ['missing role', { type: 'anyone' }, /role/],
    ['unknown role', { role: 'owner', type: 'anyone' }, /role must be one of/],
    ['non-boolean allow_file_discovery', { role: 'reader', type: 'anyone', allow_file_discovery: 'yes' }, /boolean/],
  ];
  for (const [name, args, pattern] of rejects) {
    it(`rejects ${name}`, () => {
      const res = buildSharePermission(args);
      assert.equal(typeof res, 'string');
      assert.match(res as string, pattern);
    });
  }
});

describe('google_drive_share handler', () => {
  it('creates an anyone-with-the-link permission without emailAddress or a notification param', async () => {
    const res = await call({ file_id: 'f1', role: 'reader', type: 'anyone' });
    assert.ok(!res.isError, text(res));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, '/drive/v3/files/f1/permissions');
    assert.deepEqual(sent[0].body, { role: 'reader', type: 'anyone', allowFileDiscovery: false });
    assert.equal(sent[0].params.sendNotificationEmail, undefined);
    assert.equal(JSON.parse(text(res)).type, 'anyone');
  });

  it('still shares with a user by email', async () => {
    const res = await call({ file_id: 'f1', role: 'writer', email: 'a@example.com' });
    assert.ok(!res.isError, text(res));
    assert.deepEqual(sent[0].body, { role: 'writer', type: 'user', emailAddress: 'a@example.com' });
    assert.equal(String(sent[0].params.sendNotificationEmail), 'false');
  });

  it('sends a domain share with domain, not emailAddress', async () => {
    const res = await call({ file_id: 'f1', role: 'reader', type: 'domain', domain: 'example.com', allow_file_discovery: true });
    assert.ok(!res.isError, text(res));
    assert.deepEqual(sent[0].body, { role: 'reader', type: 'domain', domain: 'example.com', allowFileDiscovery: true });
  });

  it('returns an error and sends nothing when the arguments do not fit the type', async () => {
    const res = await call({ file_id: 'f1', role: 'reader', type: 'anyone', email: 'a@example.com' });
    assert.ok(res.isError);
    assert.match(text(res), /email is not allowed/);
    assert.equal(sent.length, 0);
  });

  it('requires file_id', async () => {
    const res = await call({ role: 'reader', type: 'anyone' });
    assert.ok(res.isError);
    assert.match(text(res), /file_id/);
  });
});
