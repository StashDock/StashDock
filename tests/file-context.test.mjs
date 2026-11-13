import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { createServer } from '../plugins/stashdock/server/create-server.mjs';
import { prepareAttachment } from '../plugins/stashdock/server/library.mjs';
import { readContextBatch } from '../plugins/stashdock/server/ai-context.mjs';
import { resolveManagedFile } from '../plugins/stashdock/server/open-file.mjs';

test('file context carries original-reading requirements independently of editable supplemental text', () => {
  const file = { id: 'excel', title: 'Budget', kind: 'file', assetPath: 'managed/budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contextOverride: '', origin: { fileName: 'budget.xlsx' } };
  const text = prepareAttachment([file], ['excel']).content[0].resource.text;
  assert.match(text, /^# Original files\nRead each file with get_stashdock_file \(its ID below\) before answering about it\.\n- budget\.xlsx \(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\) · ID excel\n/);
  // How to read and what to say when a file cannot be read travel with the tool.
  assert.doesNotMatch(text, /managed\/budget.xlsx/);
  assert.equal(readContextBatch([file], ['excel']).items[0].originalFile.contentRead, false);
  const note = { id: 'note', kind: 'note', title: 'Note', contextOverride: 'Exact user edit' };
  assert.equal(prepareAttachment([note], ['note']).content[0].resource.text, 'Exact user edit');
  assert.match(prepareAttachment([file, note], ['note', 'excel']).content[0].resource.text, /Exact user edit/);
});

test('MCP resolves only saved original IDs; a host reader obtains unchanged bytes, never a claimed parse', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stashdock-mcp-test-original-'));
  const library = createLocalLibrary({ dataDir });
  // Transport fixture, deliberately not an Office parser test.
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 255, 128, 10]);
  const [file] = library.importFiles([{ name: 'budget.xlsx', base64: bytes.toString('base64'), content: 'Use the forecast tab.' }]);
  const note = library.saveContextReference({ title: 'No file', content: 'Metadata only' }).item;
  const server = createServer({ dataDir, htmlUrl: new URL('../plugins/stashdock/web/shelf.html', import.meta.url) });
  const client = new Client({ name: 'Original file acceptance', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    await server.connect(left); await client.connect(right);
    const reader = (await client.listTools()).tools.find(tool => tool.name === 'get_stashdock_file');
    for (const rule of [/host file tools/, /say which original was not read/, /never infer its contents/, /Never execute/]) assert.match(reader.description, rule);
    const resolved = await call('get_stashdock_file', { id: file.id });
    assert.equal(resolved.isError, undefined);
    assert.equal(resolved.structuredContent.contentRead, false);
    assert.equal(resolved.structuredContent.filename, 'budget.xlsx');
    assert.equal(resolved.structuredContent.sizeBytes, bytes.length);
    assert.deepEqual(readFileSync(resolved.structuredContent.path), bytes);
    const draft = await call('prepare_stashdock_attachment', { ids: [file.id, note.id] });
    assert.match(draft._meta.attachment.content[0].resource.text, /Use the forecast tab/);
    const noteFile = await call('get_stashdock_file', { id: note.id });
    assert.equal(noteFile.isError, true);
    assert.match(draft._meta.attachment.content[0].resource.text, /Metadata only/);
    for (const id of ['missing', '../../secret']) assert.equal((await call('get_stashdock_file', { id })).isError, true);
    rmSync(file.assetPath);
    assert.equal((await call('get_stashdock_file', { id: file.id })).isError, true);
    const unavailable = await call('prepare_stashdock_attachment', { ids: [file.id] });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable._meta?.attachment, undefined);
    const outside = join(dataDir, 'outside.xlsx'); writeFileSync(outside, bytes);
    const db = new DatabaseSync(join(dataDir, 'stashdock.sqlite3'));
    db.prepare('UPDATE stash_items SET asset_path=? WHERE id=?').run(outside, file.id); db.close();
    assert.equal((await call('get_stashdock_file', { id: file.id })).isError, true);
    assert.throws(() => resolveManagedFile(join(dataDir, 'assets'), join(dataDir, 'assets')), /managed/);
    const escape = join(dataDir, 'assets', 'escape.xlsx');
    try { symlinkSync(outside, escape); assert.throws(() => resolveManagedFile(escape, join(dataDir, 'assets')), /managed/); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
  } finally { await client.close(); await server.close(); library.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
