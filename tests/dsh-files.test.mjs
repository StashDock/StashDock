import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, supportsFiles } from '../plugins/stashdock-dsh/draft.mjs';
import { registerFiles, MAX_FILE_BYTES } from '../plugins/stashdock-dsh/files.mjs';
import { prepareAttachment } from '../plugins/stashdock/server/library.mjs';

function fixture(options = {}) {
  const state = { phase: 'plain', attachmentIds: ['existing'] };
  const quotes = ['Existing draft'];
  const registered = [];
  const released = [];
  const shell = {
    state: { getSnapshot: () => state },
    insertQuote(text) { if (options.rejectQuote) return false; quotes.push(text); return true; },
    addAttachments(ids) { if (options.rejectFiles) return false; state.attachmentIds.push(...ids); return true; },
    removeAttachment(id) { state.attachmentIds = state.attachmentIds.filter(value => value !== id); },
  };
  const binding = { ctx: {}, session: {
    getSnapshot: () => ({ removed: false, subagent: null }),
    projections: { faceOf: () => ({ getSnapshot: () => options.limits }) },
  } };
  const ctx = {
    sessions: { binding: () => binding }, sidebarRight: { mounted: { getSnapshot: () => 'session' } },
    conversation: {
      input: { for: () => shell }, blocks: { storeFor: () => ({ getSnapshot: () => undefined }) },
      createDrafts(session, files, uploadImages) {
        assert.equal(session, 'session'); assert.equal(uploadImages, true);
        const result = files.map((file, index) => ({ id: `new-${index}`, file }));
        registered.push(...result); return result;
      },
      resolveDraftAttachments: () => [], releaseDraftAttachments: values => released.push(...values),
    },
  };
  const bytes = new Uint8Array([0, 1, 255, 123]);
  const manifest = [{ id: 'saved-file', filename: 'original.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: bytes.length }];
  const params = { role: 'user', content: [{ type: 'text', text: 'Saved annotations and note text' }],
    _meta: { 'stashdock/dsh-draft': { send: false, title: 'Mixed references', files: ['saved-file'] } } };
  const fetch = async (url, request) => {
    assert.equal(request.method, 'POST'); assert.equal(request.signal.aborted, false);
    if (url.endsWith('/files')) return Response.json(manifest);
    assert.deepEqual(JSON.parse(request.body), { id: 'saved-file' });
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  return { ctx, state, quotes, registered, released, params, fetch, bytes, manifest };
}

test('DSH mixed selection admits byte-identical originals and one quote without replacing or sending the draft', async () => {
  const f = fixture();
  assert.equal(supportsFiles(f.ctx), true);
  assert.deepEqual(await addDraft(f.ctx, 'session', () => ({ visible: true }), f.params, new AbortController().signal, f.fetch), {});
  assert.deepEqual(f.state.attachmentIds, ['existing', 'new-0']);
  assert.deepEqual(f.quotes, ['Existing draft', 'Mixed references\n\nSaved annotations and note text']);
  assert.deepEqual(new Uint8Array(await f.registered[0].file.arrayBuffer()), f.bytes);
  assert.equal(f.registered[0].file.name, 'original.xlsx');
});

test('DSH rejected admission rolls back only newly created attachments', async () => {
  for (const rejection of ['rejectQuote', 'rejectFiles']) {
    const f = fixture({ [rejection]: true });
    assert.equal((await addDraft(f.ctx, 'session', () => ({ visible: true }), f.params, new AbortController().signal, f.fetch)).isError, true);
    assert.deepEqual(f.state.attachmentIds, ['existing']);
    assert.deepEqual(f.quotes, ['Existing draft']);
    assert.equal(f.released.length, 1);
  }
});

test('HTTP compression length does not reject a complete decoded original', async () => {
  const f = fixture();
  const fetch = async (url, request) => url.endsWith('/files') ? f.fetch(url, request)
    : new Response(f.bytes, { headers: { 'content-length': '24', 'content-encoding': 'gzip' } });
  assert.deepEqual(await addDraft(f.ctx, 'session', () => ({ visible: true }), f.params, new AbortController().signal, fetch), {});
  assert.deepEqual(new Uint8Array(await f.registered[0].file.arrayBuffer()), f.bytes);
});

test('host image limits reject before downloading bytes or changing a draft', async () => {
  const f = fixture({ limits: { mediaTypes: ['image/png'], maxImageBytes: 1, maxMessageImageBytes: 10, maxImagesPerMessage: 5 } });
  f.manifest[0].mimeType = 'image/png';
  const fetch = async (url, request) => {
    assert.ok(url.endsWith('/files'), 'Rejected image bytes should not be read');
    return f.fetch(url, request);
  };
  await assert.rejects(addDraft(f.ctx, 'session', () => ({ visible: true }), f.params, new AbortController().signal, fetch), /attachment limits/);
  assert.deepEqual(f.state.attachmentIds, ['existing']); assert.deepEqual(f.quotes, ['Existing draft']);
});

test('stale session, closed tab, cancellation and incomplete downloads never commit late', async () => {
  for (const variant of ['tab', 'binding', 'abort', 'short']) {
    const f = fixture(); const controller = new AbortController(); let visible = true;
    const fetch = async (url, request) => {
      const result = await f.fetch(url, request);
      if (url.endsWith('/file')) {
        if (variant === 'tab') visible = false;
        if (variant === 'binding') f.ctx.sessions.binding = () => undefined;
        if (variant === 'abort') controller.abort();
        if (variant === 'short') return new Response('x', { headers: { 'content-length': '4' } });
      }
      return result;
    };
    const result = await addDraft(f.ctx, 'session', () => ({ visible }), f.params, controller.signal, fetch).catch(() => ({ isError: true }));
    assert.equal(result.isError, true); assert.equal(f.registered.length, 0);
    assert.deepEqual(f.quotes, ['Existing draft']);
  }
});

test('notes and links remain quote-only; native and tool snapshots have distinct file-reading guidance', async () => {
  const f = fixture(); delete f.params._meta['stashdock/dsh-draft'].files;
  await addDraft(f.ctx, 'session', () => ({ visible: true }), f.params, new AbortController().signal, () => assert.fail('No file read expected'));
  assert.equal(f.registered.length, 0);
  const note = { id: 'note', kind: 'note', title: 'Rules', content: 'Full note text', assetPath: 'legacy.txt' };
  const file = { id: 'file', kind: 'file', title: 'Table', assetPath: 'data.xlsx', mimeType: 'application/octet-stream' };
  const native = prepareAttachment([note, file], ['note', 'file'], 'native');
  assert.deepEqual(native.files, ['file']);
  assert.doesNotMatch(native.content[0].resource.text, /Original files|File:|application\/octet-stream/);
  assert.match(native.content[0].resource.text, /Full note text/);
  assert.doesNotMatch(native.content[0].resource.text, /get_stashdock_file/);
  assert.match(prepareAttachment([file], ['file']).content[0].resource.text, /get_stashdock_file/);
});

test('DSH file-only selection admits originals without adding a quote', async () => {
  const f = fixture(); f.params.content[0].text = '';
  const outcome = await addDraft(f.ctx, 'session', () => ({ visible: true }), f.params, new AbortController().signal, f.fetch);
  assert.deepEqual(outcome, {});
  assert.deepEqual(f.quotes, ['Existing draft']);
  assert.deepEqual(f.state.attachmentIds, ['existing', 'new-0']);
});

test('file endpoints expose saved IDs and bounded binary streams, never caller paths or note files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stashdock-dsh-files-'));
  const path = join(directory, 'original.bin'); const bytes = Buffer.from([0, 255, 17, 123]);
  await writeFile(path, bytes);
  try {
    const routes = new Map();
    const ctx = { connection: { fetch: { register: value => routes.set(value.path, value.fetch) } } };
    const connect = async () => ({ client: { callTool: async ({ name, arguments: { id } }) => {
      assert.equal(name, 'get_stashdock_file');
      return id === 'saved' ? { structuredContent: { id, path, filename: 'original.bin', sizeBytes: bytes.length } }
        : id === 'large' ? { structuredContent: { id, path, filename: 'large.bin', sizeBytes: MAX_FILE_BYTES + 1 } } : { isError: true };
    } } });
    registerFiles(ctx, connect, () => false);
    const request = (route, payload) => routes.get('/api/stashdock/' + route)(new Request('http://localhost/' + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
    const manifest = await (await request('files', { ids: ['saved'] })).json();
    assert.deepEqual(manifest, [{ id: 'saved', filename: 'original.bin', sizeBytes: 4 }]);
    const file = await request('file', { id: 'saved', path: 'C:/Windows/secret' });
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal((await request('file', { path })).status, 400);
    assert.equal((await request('file', { id: path })).status, 422);
    assert.equal((await request('file', { id: 'note' })).status, 422);
    assert.equal((await request('file', { id: 'large' })).status, 422);
    assert.equal((await request('files', { ids: ['saved', 'saved'] })).status, 400);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
