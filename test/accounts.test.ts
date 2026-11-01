import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { accountForClient, deleteAccount, emailToFilename, getAccount, getAuthClient } from '../src/auth/accounts.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-mcp-accounts-test-'));
  process.env.GOOGLE_ACCOUNTS_DIR = dir;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_CLIENTS_FILE;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('account files', () => {
  it('never reads or deletes clients.json through a non-email name', async () => {
    const registry = join(dir, 'clients.json');
    await writeFile(registry, JSON.stringify({ work: { client_id: 'id', client_secret: 'secret' } }));

    assert.equal(await getAccount('clients'), null);
    assert.equal(await deleteAccount('clients'), false);
    await access(registry); // still there
  });

  it('ignores a file that is not shaped like an account', async () => {
    await writeFile(join(dir, 'x_at_example_com.json'), JSON.stringify({ hello: 'world' }));
    assert.equal(await getAccount('x@example.com'), null);
  });

  it('records the client that actually refreshes a legacy account, for reauth messages', async () => {
    await writeFile(join(dir, 'clients.json'), JSON.stringify({ work: { client_id: 'id', client_secret: 'secret' } }), { mode: 0o600 });
    const email = 'legacy@example.com';
    await writeFile(join(dir, emailToFilename(email)), JSON.stringify({
      email, name: '', picture: '', last_used: new Date().toISOString(), token_file: '',
      token: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', expiry: new Date(Date.now() + 3600_000).toISOString(), expires_in: 3600 },
    }));
    const client = await getAuthClient(email);
    assert.deepEqual(accountForClient(client), { email, client: 'work' });
  });
});
