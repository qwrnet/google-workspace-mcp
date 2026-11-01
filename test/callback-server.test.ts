import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startCallbackServer, stopCallbackServer } from '../src/auth/callback-server.js';

const creds = { name: 'default', client_id: 'id', client_secret: 'secret' };
let port: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

async function hit(state: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=${encodeURIComponent(state)}`);
  return { status: res.status, body: await res.text() };
}

async function waitForListen(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 20));
    }
  }
  throw new Error('callback server never started listening');
}

before(async () => {
  port = await freePort();
  process.env.GOOGLE_OAUTH_PORT = String(port);
});

after(() => {
  stopCallbackServer();
});

describe('callback server', () => {
  it('accepts the newest state when auth_start runs twice', async () => {
    const first = startCallbackServer('stateAAAAAAAA', creds);
    const firstOutcome = first.then(() => 'resolved', (err: Error) => err.message);
    await waitForListen();

    const second = startCallbackServer('stateBBBBBBBB', creds);
    second.catch(() => {});

    assert.match(await firstOutcome, /Superseded/);

    // The old state is now rejected, and the page names the state it wanted.
    const stale = await hit('stateAAAAAAAA');
    assert.equal(stale.status, 400);
    assert.match(stale.body, /Invalid or missing state parameter/);
    assert.match(stale.body, /beginning "stateB…"/);
    assert.match(stale.body, /received "stateA…"/);
    assert.doesNotMatch(stale.body, /stateBBBBBBBB/);

    // The new state gets past the state check (no code, so it stops there).
    const fresh = await hit('stateBBBBBBBB');
    assert.equal(fresh.status, 400);
    assert.equal(fresh.body, 'Missing authorization code');
  });
});
