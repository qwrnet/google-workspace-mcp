import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { google } from 'googleapis';
import { emailToFilename, getAuthClient } from '../src/auth/accounts.js';
import { createOAuth2Client } from '../src/auth/oauth.js';
import { withReauthRetry } from '../src/auth/reauth.js';
import type { ToolResponse } from '../src/util/types.js';

let dir: string;

// A fake Google: the token endpoint honours `liveRefresh`, the API honours `liveAccess`.
const liveRefresh = new Set<string>();
const liveAccess = new Set<string>();
const refreshCalls: string[] = [];
let issued = 0;

function httpError(status: number, data: unknown, message: string): Error {
  return Object.assign(new Error(message), { response: { status, data, config: {}, headers: {} } });
}

async function fakeTransport(opts: { url?: string; data?: string; headers?: Record<string, string> }) {
  const url = String(opts.url);
  if (url.includes('oauth2.googleapis.com/token')) {
    const rt = new URLSearchParams(opts.data).get('refresh_token')!;
    refreshCalls.push(rt);
    if (!liveRefresh.has(rt)) throw httpError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 'invalid_grant');
    const at = `at-${++issued}`;
    liveAccess.add(at);
    return { status: 200, data: { access_token: at, expires_in: 3600, token_type: 'Bearer' }, headers: {}, config: opts };
  }
  const at = opts.headers?.Authorization?.replace(/^Bearer /, '') ?? '';
  if (!liveAccess.has(at)) throw httpError(401, { error: { code: 401 } }, 'Unauthorized');
  return { status: 200, data: { emailAddress: 'me' }, headers: {}, config: opts };
}

async function writeAccount(email: string, refreshToken: string, accessToken: string, expiry: Date): Promise<string> {
  const file = join(dir, emailToFilename(email));
  await writeFile(file, JSON.stringify({
    email, name: '', picture: '',
    token: { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expiry: expiry.toISOString(), expires_in: 0 },
    last_used: new Date().toISOString(), token_file: file,
  }));
  return file;
}

// Whole seconds, so it can be restored exactly
const PINNED_MTIME = 1_700_000_000;

/** Rewrite the file but keep its (pinned) mtime, so only the invalid_grant path can notice. */
async function rewriteKeepingMtime(email: string, refreshToken: string, accessToken: string): Promise<void> {
  const file = join(dir, emailToFilename(email));
  await writeAccount(email, refreshToken, accessToken, new Date(Date.now() + 3600_000));
  await utimes(file, PINNED_MTIME, PINNED_MTIME);
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function profileHandler(email: string, calls: { n: number }) {
  return withReauthRetry(async (): Promise<ToolResponse> => {
    calls.n++;
    const auth = await getAuthClient(email);
    const { data } = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    return { content: [{ type: 'text', text: `ok ${data.emailAddress}` }] };
  });
}

/** Builds and caches a working client for `email`, then expires its access token. */
async function warmThenExpire(email: string, calls: { n: number }) {
  liveRefresh.add(`rt-old-${email}`);
  await writeAccount(email, `rt-old-${email}`, 'expired', new Date(0));
  const handler = profileHandler(email, calls);
  assert.ok(!(await handler({})).isError); // creates the client, refreshes once
  await settle(); // let the 'tokens' listener write
  await utimes(join(dir, emailToFilename(email)), PINNED_MTIME, PINNED_MTIME);
  assert.ok(!(await handler({})).isError); // records the file's mtime
  calls.n = 0;
  const client = await getAuthClient(email);
  client.credentials.expiry_date = Date.now() - 1; // an hour later...
  liveRefresh.delete(`rt-old-${email}`); // ...and the grant has been revoked
  refreshCalls.length = 0;
  return { handler, client };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-mcp-test-'));
  process.env.GOOGLE_ACCOUNTS_DIR = dir;
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  const proto = Object.getPrototypeOf(createOAuth2Client().transporter);
  mock.method(proto, 'request', fakeTransport);
});

after(async () => {
  mock.restoreAll();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  refreshCalls.length = 0;
});

describe('re-authentication by another process', () => {
  it('retries once with the new token after invalid_grant when the file was rewritten', async () => {
    const email = 'a@example.com';
    const calls = { n: 0 };
    const { handler } = await warmThenExpire(email, calls);

    liveRefresh.add(`rt-new-${email}`);
    liveAccess.add(`at-fresh-${email}`);
    await rewriteKeepingMtime(email, `rt-new-${email}`, `at-fresh-${email}`);

    const res = await handler({});
    assert.ok(!res.isError);
    assert.equal(res.content[0].text, 'ok me');
    assert.equal(calls.n, 2);
    assert.deepEqual(refreshCalls, [`rt-old-${email}`]);

    // and the next call reuses the rebuilt client
    assert.ok(!(await handler({})).isError);
    assert.equal(calls.n, 3);
  });

  it('returns the re-auth error without looping when the file is unchanged', async () => {
    const email = 'b@example.com';
    const calls = { n: 0 };
    const { handler } = await warmThenExpire(email, calls);

    const res = await handler({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text,
      `Error: ${email}'s Google login expired or was revoked; run google_accounts_auth_start and sign in as that account.`,
    );
    assert.equal(calls.n, 1);
    assert.deepEqual(refreshCalls, [`rt-old-${email}`]);
  });

  it('does not retry once a request may have reached the API', async () => {
    const email = 'c@example.com';
    const calls = { n: 0 };
    const { client } = await warmThenExpire(email, calls);
    liveRefresh.add(`rt-old-${email}`); // still valid for the first request

    liveRefresh.add(`rt-new-${email}`);
    liveAccess.add(`at-fresh-${email}`);
    const handler = withReauthRetry(async (): Promise<ToolResponse> => {
      calls.n++;
      const auth = await getAuthClient(email);
      const gmail = google.gmail({ version: 'v1', auth });
      await gmail.users.getProfile({ userId: 'me' }); // succeeds
      liveRefresh.delete(`rt-old-${email}`);
      client.credentials.expiry_date = Date.now() - 1;
      await rewriteKeepingMtime(email, `rt-new-${email}`, `at-fresh-${email}`);
      await gmail.users.getProfile({ userId: 'me' }); // invalid_grant
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const res = await handler({});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /may already have run/);
    assert.equal(calls.n, 1);
  });

  it('rebuilds a cached client before use when the file has a new refresh token', async () => {
    const email = 'd@example.com';
    const calls = { n: 0 };
    const { handler } = await warmThenExpire(email, calls);

    liveRefresh.add(`rt-new-${email}`);
    await writeAccount(email, `rt-new-${email}`, 'expired', new Date(0));

    assert.ok(!(await handler({})).isError);
    assert.equal(calls.n, 1);
    assert.deepEqual(refreshCalls, [`rt-new-${email}`]); // never tried the dead token
  });

  it("a replaced client's late refresh does not overwrite the new login", async () => {
    const email = 'e@example.com';
    const calls = { n: 0 };
    const { client } = await warmThenExpire(email, calls);
    liveRefresh.add(`rt-old-${email}`);

    await writeAccount(email, `rt-new-${email}`, 'at-new', new Date(Date.now() + 3600_000));
    await client.refreshAccessToken(); // old client finishes a refresh after the re-auth
    await settle();

    const saved = JSON.parse(await readFile(join(dir, emailToFilename(email)), 'utf-8'));
    assert.equal(saved.token.refresh_token, `rt-new-${email}`);
    assert.equal(saved.token.access_token, 'at-new');
  });

  it('keeps the cached client while the account file is unreadable', async () => {
    const email = 'f@example.com';
    const calls = { n: 0 };
    const { handler, client } = await warmThenExpire(email, calls);
    liveRefresh.add(`rt-old-${email}`);
    client.credentials.expiry_date = Date.now() + 3600_000;

    await writeFile(join(dir, emailToFilename(email)), '{"email": "f@exa'); // caught mid-write
    assert.ok(!(await handler({})).isError);
    assert.equal(await getAuthClient(email), client);
  });

  it('leaves other errors alone', async () => {
    const handler = withReauthRetry(async () => {
      throw new Error('boom');
    });
    await assert.rejects(handler({}), /boom/);
  });
});
