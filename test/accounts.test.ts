import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { deleteAccount, getAccount } from '../src/auth/accounts.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-mcp-accounts-test-'));
  process.env.GOOGLE_ACCOUNTS_DIR = dir;
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
});
