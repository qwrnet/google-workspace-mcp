import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { google } from 'googleapis';
import { checkOutputPath, getAttachmentRoots, listAttachments, openOutputTarget, writeNewFile } from '../src/util/attachments.js';
import { register } from '../src/services/gmail.js';
import type { ToolResponse } from '../src/util/types.js';

let dir: string;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const PDF = Buffer.from('%PDF-1.4 fake contract');

// multipart/mixed -> [multipart/alternative -> [text, html with inline image], contract.pdf, notes.txt (inline data)]
const payload = {
  partId: '',
  mimeType: 'multipart/mixed',
  filename: '',
  body: { size: 0 },
  parts: [
    {
      partId: '0',
      mimeType: 'multipart/alternative',
      filename: '',
      body: { size: 0 },
      parts: [
        { partId: '0.0', mimeType: 'text/plain', filename: '', body: { size: 5, data: b64('hello') } },
        {
          partId: '0.1',
          mimeType: 'multipart/related',
          filename: '',
          body: { size: 0 },
          parts: [
            { partId: '0.1.0', mimeType: 'text/html', filename: '', body: { size: 12, data: b64('<p>hello</p>') } },
            { partId: '0.1.1', mimeType: 'image/png', filename: '', body: { size: 900, attachmentId: 'img-1' } },
          ],
        },
      ],
    },
    { partId: '1', mimeType: 'application/pdf', filename: 'contract.pdf', body: { size: PDF.length, attachmentId: 'att-fresh', data: '' } },
    { partId: '2', mimeType: 'text/plain', filename: 'notes.txt', body: { size: 5, data: b64('notes') } },
    { partId: '3', mimeType: 'application/zip', filename: 'huge.zip', body: { size: 30 * 1024 * 1024, attachmentId: 'att-huge' } },
    { partId: '4', mimeType: 'text/plain', filename: 'empty.txt', body: { size: 0 } },
  ],
};

const attachmentGets: string[] = [];

async function fakeTransport(opts: { url?: string }) {
  const url = String(opts.url);
  const att = url.match(/\/messages\/([^/]+)\/attachments\/([^/?]+)/);
  if (att) {
    attachmentGets.push(att[2]);
    return { status: 200, data: { size: PDF.length, data: b64(PDF) }, headers: {}, config: opts };
  }
  if (/\/messages\/m1(\?|$)/.test(url)) {
    return { status: 200, data: { id: 'm1', threadId: 't1', payload }, headers: {}, config: opts };
  }
  throw Object.assign(new Error('Not found'), { response: { status: 404, data: {}, config: {}, headers: {} } });
}

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResponse>>();
const save = (args: Record<string, unknown>) => handlers.get('google_gmail_save_attachment')!(args);
const text = (r: ToolResponse) => (r.content[0] as { text: string }).text;

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'gw-mcp-gmail-test-')));
  const proto = Object.getPrototypeOf(new google.auth.OAuth2().transporter);
  mock.method(proto, 'request', fakeTransport);
  const auth = new google.auth.OAuth2('id', 'secret');
  auth.setCredentials({ access_token: 'at', expiry_date: Date.now() + 3600_000 });
  register((name, fn) => handlers.set(name, fn), async () => auth);
});

after(async () => {
  mock.restoreAll();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  attachmentGets.length = 0;
});

describe('listAttachments', () => {
  it('finds named files at any depth and skips unnamed inline parts', () => {
    assert.deepEqual(listAttachments(payload), [
      { part_id: '1', attachment_id: 'att-fresh', filename: 'contract.pdf', mime_type: 'application/pdf', size: PDF.length },
      { part_id: '2', attachment_id: null, filename: 'notes.txt', mime_type: 'text/plain', size: 5 },
      { part_id: '3', attachment_id: 'att-huge', filename: 'huge.zip', mime_type: 'application/zip', size: 30 * 1024 * 1024 },
      { part_id: '4', attachment_id: null, filename: 'empty.txt', mime_type: 'text/plain', size: 0 },
    ]);
  });

  it('handles a message that is a single attachment, and an empty payload', () => {
    const single = { partId: '', mimeType: 'application/pdf', filename: 'a.pdf', body: { size: 3, attachmentId: 'x' } };
    assert.equal(listAttachments(single).length, 1);
    assert.deepEqual(listAttachments(undefined), []);
  });
});

describe('checkOutputPath', () => {
  it('rejects relative and non-normalized paths', async () => {
    assert.match((await checkOutputPath('out.pdf', [dir]))!, /absolute/);
    assert.match((await checkOutputPath(`${dir}/x/../out.pdf`, [dir]))!, /normalized/);
    assert.match((await checkOutputPath(`${dir}/out/`, [dir]))!, /normalized/);
  });

  it('rejects a missing parent and a parent that is a file', async () => {
    assert.match((await checkOutputPath(join(dir, 'missing', 'out.pdf'), [dir]))!, /does not exist/);
    await writeFile(join(dir, 'afile'), '');
    assert.match((await checkOutputPath(join(dir, 'afile', 'out.pdf'), [dir]))!, /not a directory/);
  });

  it('rejects a parent reached through a symlink', async () => {
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'link'));
    assert.match((await checkOutputPath(join(dir, 'link', 'out.pdf'), [dir]))!, /symlink/);
    assert.equal(await checkOutputPath(join(dir, 'real', 'out.pdf'), [dir]), null);
  });

  it('confines writes to the roots and refuses dot-named paths below them', async () => {
    await mkdir(join(dir, 'root', '.git', 'hooks'), { recursive: true });
    const roots = [join(dir, 'root')];
    assert.equal(await checkOutputPath(join(dir, 'root', 'a.pdf'), roots), null);
    assert.match((await checkOutputPath(join(dir, 'a.pdf'), roots))!, /must be inside one of/);
    assert.match((await checkOutputPath(join(dir, 'root', '.git', 'hooks', 'pre-commit'), roots))!, /dot-named/);
    assert.match((await checkOutputPath(join(dir, 'root', '.bashrc'), roots))!, /dot-named/);
    await mkdir(join(dir, 'root', '.cache'));
    const overlapping = join(dir, 'root', '.cache', 'r.pdf');
    assert.equal(await checkOutputPath(overlapping, [join(dir, 'root'), join(dir, 'root', '.cache')]), null);
    assert.equal(await checkOutputPath(overlapping, [join(dir, 'root', '.cache'), join(dir, 'root')]), null);
  });

  it('defaults to the temp directory and ~/.cache, and GOOGLE_ATTACHMENTS_ROOT replaces them', async () => {
    const saved = process.env.GOOGLE_ATTACHMENTS_ROOT;
    try {
      delete process.env.GOOGLE_ATTACHMENTS_ROOT;
      assert.ok(getAttachmentRoots().includes(join(homedir(), '.cache')));
      const autostart = join(homedir(), '.config', 'autostart', 'x.desktop');
      assert.match((await checkOutputPath(autostart, getAttachmentRoots()))!, /must be inside one of/);
      process.env.GOOGLE_ATTACHMENTS_ROOT = `/srv/a:${dir}`;
      assert.deepEqual(getAttachmentRoots(), ['/srv/a', dir]);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_ATTACHMENTS_ROOT;
      else process.env.GOOGLE_ATTACHMENTS_ROOT = saved;
    }
  });
});

describe('writeNewFile', () => {
  it('never overwrites a file or follows a symlink', async () => {
    const existing = join(dir, 'existing.pdf');
    await writeFile(existing, 'keep');
    await assert.rejects(writeNewFile(existing, PDF), { code: 'EEXIST' });
    assert.equal(await readFile(existing, 'utf-8'), 'keep');

    const target = join(dir, 'target.txt');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'trap.pdf'));
    await assert.rejects(writeNewFile(join(dir, 'trap.pdf'), PDF), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf-8'), 'keep');
  });
});

describe('openOutputTarget', () => {
  const linuxOnly = { skip: process.platform !== 'linux' && 'needs /proc/self/fd' };

  it('keeps writing into the checked directory after its path is swapped for a symlink', linuxOnly, async () => {
    const checked = join(dir, 'checked');
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(checked);
    await mkdir(elsewhere);
    const target = await openOutputTarget(join(checked, 'out.pdf'));
    assert.ok(!('error' in target));

    await rename(checked, join(dir, 'moved'));
    await symlink(elsewhere, checked);
    try {
      await target.write(PDF);
    } finally {
      await target.close();
    }
    assert.deepEqual(await readFile(join(dir, 'moved', 'out.pdf')), PDF);
    await assert.rejects(access(join(elsewhere, 'out.pdf')));
  });

  it('reports an existing file before anything is downloaded', async () => {
    await writeFile(join(dir, 'there.pdf'), '');
    const target = await openOutputTarget(join(dir, 'there.pdf'));
    assert.ok('error' in target && /already exists/.test(target.error));
  });
});

describe('google_gmail_save_attachment', () => {
  it('saves a zero-byte attachment', async () => {
    const out = join(dir, 'empty.txt');
    const res = await save({ message_id: 'm1', part_id: '4', output_path: out });
    assert.ok(!res.isError, text(res));
    assert.equal(JSON.parse(text(res)).bytes_written, 0);
    assert.equal((await stat(out)).size, 0);
    assert.deepEqual(attachmentGets, []);
  });

  it('saves by part_id using the attachmentId from a fresh fetch', async () => {
    const out = join(dir, 'contract.pdf');
    const res = await save({ message_id: 'm1', part_id: '1', output_path: out });
    assert.ok(!res.isError, text(res));
    assert.deepEqual(JSON.parse(text(res)), {
      path: out, filename: 'contract.pdf', mime_type: 'application/pdf', bytes_written: PDF.length,
    });
    assert.deepEqual(await readFile(out), PDF);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.deepEqual(attachmentGets, ['att-fresh']);
  });

  it('saves an attachment whose data is inline without a second request', async () => {
    const out = join(dir, 'notes.txt');
    const res = await save({ message_id: 'm1', part_id: '2', output_path: out });
    assert.ok(!res.isError, text(res));
    assert.equal(await readFile(out, 'utf-8'), 'notes');
    assert.deepEqual(attachmentGets, []);
  });

  it('refuses oversize attachments before downloading', async () => {
    const res = await save({ message_id: 'm1', part_id: '3', output_path: join(dir, 'huge.zip') });
    assert.ok(res.isError);
    assert.match(text(res), /limit/);
    assert.deepEqual(attachmentGets, []);
  });

  it('reports an unknown part, a relative path, and an existing file as errors', async () => {
    assert.match(text(await save({ message_id: 'm1', part_id: '0.0', output_path: join(dir, 'x') })), /No attachment/);
    assert.match(text(await save({ message_id: 'm1', part_id: '1', output_path: 'contract.pdf' })), /absolute/);
    await writeFile(join(dir, 'dup.pdf'), 'keep');
    assert.match(text(await save({ message_id: 'm1', part_id: '1', output_path: join(dir, 'dup.pdf') })), /already exists/);
    assert.equal(await readFile(join(dir, 'dup.pdf'), 'utf-8'), 'keep');
  });
});
