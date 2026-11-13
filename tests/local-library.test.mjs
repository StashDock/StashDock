import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalLibrary, dataDirectory } from '../plugins/stashdock/server/local-library.mjs';
import { startCaptureBridge } from '../plugins/stashdock/server/capture-bridge.mjs';
import { createServer } from '../plugins/stashdock/server/create-server.mjs';
import { buildContext } from '../src/lib/context-format.mjs';
import { prepareAttachment, tagRevision } from '../plugins/stashdock/server/library.mjs';
const fixture = { title: 'A saved page', kind: 'web', url: 'https://example.test/page?utm_source=x#fragment', source: 'Example',
  excerpt: 'Summary', content: 'The complete body', tags: ['Design'], createdAt: '2026-10-10T00:00:00Z' };
function temporary(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'stashdock-mcp-test-'));
  t.after(() => { assert.ok(dataDir.startsWith(join(tmpdir(), 'stashdock-mcp-test-'))); rmSync(dataDir, { recursive: true, force: true }); });
  return dataDir;
}
test('portable data directory matches native desktop conventions and honors the override', () => {
  assert.equal(dataDirectory({ APPDATA: 'C:/Roaming' }, 'win32', 'C:/User'), join('C:/Roaming', 'app.stashdock.desktop'));
  assert.equal(dataDirectory({}, 'darwin', '/Users/test'), join('/Users/test', 'Library', 'Application Support', 'app.stashdock.desktop'));
  assert.equal(dataDirectory({ XDG_DATA_HOME: '/data' }, 'linux', '/home/test'), join('/data', 'app.stashdock.desktop'));
});
test('SQLite core works with no desktop, preserves concurrent changes, and updates native FTS', async t => {
  const dataDir = temporary(t), a = createLocalLibrary({ dataDir }), b = createLocalLibrary({ dataDir });
  try {
    const [item] = a.importItems([fixture]).items;
    b.setFavorite(item.id, true); a.setTags([item.id], ['Research']);
    const row = (await b.read())[0];
    assert.equal(row.favorite, true); assert.deepEqual(row.tags, ['Research']); assert.equal(row.content, fixture.content);
    assert.equal(row.url, 'https://example.test/page');
    assert.equal(a.importItems([{ ...fixture, title: 'Do not overwrite', tags: ['Bad'], url: row.url }]).skipped, 1);
    assert.equal((await a.read())[0].title, fixture.title); assert.equal((await a.read())[0].favorite, true);
    const db = new DatabaseSync(join(dataDir, 'stashdock.sqlite3'));
    // Desktop's pinned tags follow a rename or removal made from the AI plugin.
    db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES ('desktop_pinned_tags_v1', ?)").run(JSON.stringify(['Research', 'Other']));
    a.changeTag('research', 'Ideas'); assert.deepEqual((await b.read())[0].tags, ['Ideas']);
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='desktop_pinned_tags_v1'").get().value), ['Ideas', 'Other']);
    assert.equal(db.prepare("SELECT count(*) AS n FROM stash_fts WHERE stash_fts MATCH 'Ideas'").get().n, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='library_initialized_v1'").get().value, '1');
    a.changeTag('Ideas', null); assert.deepEqual((await b.read())[0].tags, []);
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='desktop_pinned_tags_v1'").get().value), ['Other']);
    assert.throws(() => a.setTags([item.id, 'missing'], ['Fail']), /no longer/); assert.deepEqual((await b.read())[0].tags, []);
    a.remove(item.id); assert.equal((await b.read()).length, 0);
    db.close();
  } finally { b.close(); a.close(); }
});
test('replacing a saved link clears prior final context and cover without adding another card', async t => {
  const dataDir = temporary(t), library = createLocalLibrary({ dataDir });
  try {
    const [item] = library.importItems([{...fixture,preview:'data:image/png;base64,AAAA'}]).items;
    library.setFavorite(item.id, true); library.editContext(item.id, 'My context');
    const replaced = library.replaceLink({ ...fixture, url: fixture.url + '#again', title: 'New title', content: 'New body', tags: ['Fresh'],preview:undefined });
    assert.equal(replaced.id, item.id);
    const [row] = await library.read();
    assert.equal(row.title, 'New title'); assert.deepEqual(row.tags, ['Fresh']); assert.equal(row.content, 'New body');
    assert.equal(row.favorite, false); assert.equal(row.contextOverride, undefined); assert.equal(row.createdAt, item.createdAt);
    assert.equal(row.preview,undefined);assert.match(buildContext([row]),/New body/);assert.doesNotMatch(buildContext([row]),/My context/);
    library.editContext(item.id,'');
    const fresh=library.replaceLink({...fixture,content:'Latest body'});
    assert.equal(fresh.contextOverride,undefined);assert.match(buildContext([fresh]),/Latest body/);
    library.remove(item.id);
    assert.throws(()=>library.replaceLink(fixture),/changed/);
    assert.equal((await library.read()).length, 0);
  } finally { library.close(); }
});
test('bulk deletion is atomic, idempotent and removes the deleted references\' library copies', async t => {
  const dataDir = temporary(t), library = createLocalLibrary({ dataDir });
  const db = new DatabaseSync(join(dataDir, 'stashdock.sqlite3'));
  try {
    const [a] = library.importFiles([{ name: 'keep.txt', mimeType: 'text/plain', base64: Buffer.from('original bytes').toString('base64') }]);
    const [b] = library.importItems([fixture]).items;
    db.exec(`CREATE TRIGGER reject_bulk_delete BEFORE DELETE ON stash_items WHEN OLD.id='${b.id}' BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
    assert.throws(() => library.removeMany([a.id, b.id]), /test failure/);
    assert.equal((await library.read()).length, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM stash_fts').get().n, 2);
    assert.equal(readFileSync(a.assetPath, 'utf8'), 'original bytes', 'a rolled-back delete keeps the file');
    db.exec('DROP TRIGGER reject_bulk_delete');
    assert.throws(() => library.removeMany([a.id, '']), /valid references/);
    assert.equal((await library.read()).length, 2);
    assert.deepEqual(library.removeMany([a.id, a.id, b.id]), { deleted: 2 });
    assert.deepEqual(library.removeMany([a.id, b.id]), { deleted: 0 });
    assert.equal((await library.read()).length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM stash_fts').get().n, 0);
    assert.throws(() => readFileSync(a.assetPath), /ENOENT/);
  } finally { db.close(); library.close(); }
});

test('AI tag patches preserve unmentioned tags and reject stale or ambiguous writes', async t => {
  const library = createLocalLibrary({ dataDir: temporary(t) });
  try {
    const [item] = library.importItems([{ ...fixture, tags: ['Keep', 'Old'] }]).items;
    const current = (await library.readItems([item.id]))[0];
    const applied = library.applyTagChanges([{ id: item.id, expectedRevision: tagRevision(current), addTags: ['Research'], removeTags: ['old'] }]);
    assert.equal(applied.updated, 1); assert.deepEqual(applied.results[0].tags, ['Keep', 'Research']);
    assert.throws(() => library.applyTagChanges([{ id: item.id, expectedRevision: applied.results[0].tagRevision, addTags: ['Same'], removeTags: ['same'] }]), /same tag/);
    assert.deepEqual((await library.readItems([item.id]))[0].tags, ['Keep', 'Research']);
    library.setTags([item.id], ['Manual']);
    const stale = library.applyTagChanges([{ id: item.id, expectedRevision: applied.results[0].tagRevision, addTags: ['Wrong'], removeTags: [] }]);
    assert.equal(stale.conflicts, 1); assert.equal(stale.results[0].reason, 'changed');
    assert.deepEqual((await library.readItems([item.id]))[0].tags, ['Manual']);
  } finally { library.close(); }
});
test('imports are atomic, canonical duplicates are skipped, user paths are never accepted', async t => {
  const library = createLocalLibrary({ dataDir: temporary(t) });
  try {
    assert.throws(() => library.importItems([fixture, { ...fixture, url: 'file:///secret' }]), /http/);
    assert.equal((await library.read()).length, 0);
    const result = library.importItems([fixture, fixture]); assert.equal(result.imported, 1); assert.equal(result.skipped, 1);
    assert.equal((await library.read())[0].assetPath, undefined);
    assert.throws(() => library.importItems([{ ...fixture, kind: 'file', assetPath: 'C:/secret' }]), /file importer/);
    assert.throws(() => library.importItems([{ ...fixture, url: 'https://other.test', tags: ['x'.repeat(49)] }]), /48/);
    assert.equal((await library.read()).length, 1);
  } finally { library.close(); }
});
test('file imports keep actual bytes and text, sanitize paths, and deleting removes only the library copy', async t => {
  const dataDir = temporary(t), library = createLocalLibrary({ dataDir });
  try {
    const body = '# Full note\nNot just metadata.';
    const [item] = library.importFiles([{ name: '../../outside.md', mimeType: 'text/markdown', base64: Buffer.from(body).toString('base64') }]);
    assert.equal(item.title, 'outside.md'); assert.equal(item.content, body);
    assert.ok(item.assetPath.startsWith(join(dataDir, 'assets'))); assert.equal(readFileSync(item.assetPath, 'utf8'), body);
    assert.equal(item.originalPath, undefined);
    assert.throws(() => library.importFiles([{ name: 'bad', base64: 'invalid!' }]), /invalid/);
    assert.throws(() => library.importFiles([{ name: 'large', base64: Buffer.alloc(5_000_001).toString('base64') }]), /5 MB/);
    assert.equal(readdirSync(join(dataDir, 'assets')).length, 1);
    library.remove(item.id); assert.throws(() => readFileSync(item.assetPath), /ENOENT/);
  } finally { library.close(); }
});
test('App management tools are app-only writes; model search remains read-only', async t => {
  const dataDir = temporary(t);
  const server = createServer({ dataDir, htmlUrl: new URL('../plugins/stashdock/web/shelf.html', import.meta.url) });
  const client = new Client({ name: 'Isolated management test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await client.connect(right);
    const { tools } = await client.listTools();
    const writes = tools.filter(tool => tool.annotations.readOnlyHint === false);
    assert.equal(writes.length, 25);
    for (const name of ['set_stashdock_sort', 'record_stashdock_use']) assert.ok(writes.some(tool => tool.name === name && tool._meta?.ui?.visibility?.includes('app')));
    assert.ok(writes.some(tool => tool.name === 'replace_stashdock_link' && tool._meta?.ui?.visibility?.includes('app')));
    assert.ok(writes.some(tool => tool.name === 'open_stashdock_integration'));
    assert.ok(writes.some(tool => tool.name === 'save_stashdock_preferences'));
    assert.ok(writes.some(tool => tool.name === 'save_stashdock_capture_platform'));
    assert.ok(writes.some(tool => tool.name === 'open_stashdock_capture_site'));
    for (const name of ['connect_stashdock_platform','disconnect_stashdock_platform','read_stashdock_platform']) assert.ok(!tools.some(tool => tool.name === name));
    const modelWrites = new Set(['save_stashdock_reference', 'apply_stashdock_tag_changes']);
    for (const tool of writes.filter(tool => !modelWrites.has(tool.name))) { assert.deepEqual(tool._meta.ui.visibility, ['app']); assert.equal(tool._meta.ui.resourceUri, undefined); }
    assert.deepEqual(writes.filter(tool => !tool._meta?.ui?.visibility).map(tool => tool.name), [...modelWrites]);
    assert.equal(tools.find(tool => tool.name === 'search_stashdock').annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'delete_stashdock_reference').annotations.destructiveHint, true);
    assert.equal(tools.find(tool => tool.name === 'delete_stashdock_references').annotations.destructiveHint, true);
    const imported = await client.callTool({ name: 'import_stashdock_references', arguments: { items: [fixture] } });
    assert.equal(imported.structuredContent.imported, 1);
    const listed = await client.callTool({ name: 'list_stashdock_shelf', arguments: {} });
    const id = listed._meta.items[0].id;
    assert.deepEqual(listed._meta.tags, [{ name: 'Design', count: 1 }]);
    await client.callTool({ name: 'set_stashdock_favorite', arguments: { id, favorite: true } });
    const detail = await client.callTool({ name: 'get_stashdock_item', arguments: { id } });
    assert.equal(detail.structuredContent.content, fixture.content); assert.equal(detail.structuredContent.favorite, true);
    assert.equal((await client.callTool({ name: 'delete_stashdock_reference', arguments: { id } })).structuredContent.deleted, true);
    await client.callTool({ name: 'import_stashdock_references', arguments: { items: [fixture, { ...fixture, url: 'https://second.test', title: 'Second' }] } });
    const bulkRows = (await client.callTool({ name: 'list_stashdock_shelf', arguments: {} }))._meta.items;
    assert.equal(bulkRows.length, 2);
    assert.equal((await client.callTool({ name: 'delete_stashdock_references', arguments: { ids: bulkRows.map(row => row.id) } })).structuredContent.deleted, 2);
    assert.equal((await client.callTool({ name: 'list_stashdock_shelf', arguments: {} }))._meta.items.length, 0);
  } finally { await client.close(); await server.close(); }
});
test('complete context overrides survive reopening, metadata edits and duplicate captures', async t => {
  const dataDir = temporary(t), library = createLocalLibrary({ dataDir });
  const [item] = library.importItems([fixture]).items;
  const final = '# StashDock context\n\n## Edited snapshot\nSource: curated\n\n  ' + '😀'.repeat(25_000);
  try {
    library.editContext(item.id, final);
    library.editMetadata(item.id, 'Edited card', ['Research']);
    library.importItems([{ ...fixture, title: 'Capture retry', content: 'Do not overwrite', tags: [] }]);
    const saved = (await library.read())[0];
    assert.equal(saved.contextOverride, final); assert.equal(saved.content, fixture.content); assert.equal(saved.excerpt, fixture.excerpt);
    assert.equal(saved.title, 'Edited card'); assert.deepEqual(saved.tags, ['Research']);
    assert.equal(prepareAttachment([saved], [saved.id]).content[0].resource.text, final);
    assert.throws(() => library.editContext(item.id, 'x'.repeat(200_001)), /200,000/);
    assert.throws(() => library.editContext('missing', ''), /no longer/);
  } finally { library.close(); }
  const reopened = createLocalLibrary({ dataDir });
  try { const saved = (await reopened.read())[0]; assert.equal(buildContext([saved]), final); reopened.editContext(saved.id, ''); assert.equal(buildContext(await reopened.read()), ''); }
  finally { reopened.close(); }
});

test('App editor fetch and writes do not leak full bodies into model-facing results', async t => {
  const dataDir = temporary(t), library = createLocalLibrary({ dataDir });
  const [item] = library.importItems([fixture]).items; library.close();
  const server = createServer({ dataDir, htmlUrl: new URL('../plugins/stashdock/web/shelf.html', import.meta.url) });
  const client = new Client({ name: 'Context editor test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await client.connect(right);
    const { tools } = await client.listTools();
    for (const name of ['get_stashdock_context', 'edit_stashdock_context', 'edit_stashdock_reference']) {
      const tool = tools.find(tool => tool.name === name); assert.deepEqual(tool._meta.ui.visibility, ['app']); assert.equal(tool._meta.ui.resourceUri, undefined);
    }
    const editor = await client.callTool({ name: 'get_stashdock_context', arguments: { id: item.id } });
    assert.equal(editor._meta.context, buildContext([item])); assert.equal(editor.structuredContent.context, undefined);
    const final = '# StashDock context\n\n## Curated\nVerbatim editor text';
    const saved = await client.callTool({ name: 'edit_stashdock_context', arguments: { id: item.id, context: final } });
    assert.equal(saved.isError, undefined); assert.doesNotMatch(JSON.stringify(saved.content), /Verbatim editor text/);
    const prepared = await client.callTool({ name: 'prepare_stashdock_attachment', arguments: { ids: [item.id] } });
    assert.equal(prepared._meta.attachment.content[0].resource.text, final);
    const listed = await client.callTool({ name: 'list_stashdock_shelf', arguments: {} });
    assert.equal(listed._meta.items[0].contextOverride, undefined); assert.equal(listed._meta.items[0].content, undefined);
    assert.equal((await client.callTool({ name: 'edit_stashdock_reference', arguments: { id: item.id, title: 'Renamed', tags: ['Ideas'] } })).structuredContent.item.title, 'Renamed');
    assert.equal((await client.callTool({ name: 'get_stashdock_context', arguments: { id: item.id } }))._meta.context, final);
  } finally { await client.close(); await server.close(); }
});

test('headless capture bridge accepts extension capture, rejects other origins and unsafe routes', async t => {
  const library = createLocalLibrary({ dataDir: temporary(t), browserEnabled: () => true });
  const bridge = startCaptureBridge(library, 0); await once(bridge, 'listening');
  const port = bridge.address().port;
  const extensionId = 'a'.repeat(32);
  const headers = { Origin: `chrome-extension://${extensionId}`, 'X-StashDock-Client': 'chrome-extension-v1', 'Content-Type': 'application/json' };
  const endpoint = `http://127.0.0.1:${port}/v1`;
  try {
    assert.equal((await fetch(endpoint + '/setup', { method: 'POST', headers, body: JSON.stringify({ browser: 'chrome', version: '0.4.13', extensionId }) })).status, 200);
    const importResult = await fetch(endpoint + '/import', { method: 'POST', headers, body: JSON.stringify({ items: [fixture] }) }); assert.equal(importResult.status, 200);
    assert.equal((await fetch(endpoint + '/items', { headers })).status,404);
    const summary=await(await fetch(endpoint+'/capture?url='+encodeURIComponent(fixture.url),{headers})).json();assert.ok(summary.duplicate.id);assert.equal(summary.duplicate.content,undefined);
    assert.equal((await fetch(endpoint + '/items', { headers: { ...headers, Origin: 'https://attacker.test' } })).status, 403);
    // Fetch normalizes Host, so use the native HTTP client for DNS-rebinding checks.
    const { request } = await import('node:http');
    const status = await new Promise(resolve => { const req = request(endpoint + '/items', { headers: { ...headers, Host: 'attacker.test' } }, response => { response.resume(); resolve(response.statusCode); }); req.end(); });
    assert.equal(status, 403);
    assert.equal((await fetch(endpoint + '/items')).status, 403);
    assert.equal((await fetch(endpoint + '/import', { method: 'POST', headers, body: JSON.stringify({ items: [{ ...fixture, kind: 'file' }] }) })).status, 400);
  } finally { await new Promise(resolve => bridge.close(resolve)); library.close(); }
});
test('an active MCP conversation takes over the browser bridge after its previous owner closes', async t => {
  const library = createLocalLibrary({ dataDir: temporary(t) });
  const owner = startCaptureBridge(library, 0); await once(owner, 'listening');
  const port = owner.address().port, successor = startCaptureBridge(library, port);
  try {
    const [error] = await once(successor, 'error'); assert.equal(error.code, 'EADDRINUSE');
    await new Promise(resolve => owner.close(resolve));
    await once(successor, 'listening');
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { 'X-StashDock-Client': 'chrome-extension-v1' } });
    assert.equal(response.status, 200);
  } finally { await new Promise(resolve => successor.close(resolve)); owner.close(); library.close(); }
});

test('tag length counts UTF-16 units, the same rule as Desktop (library.rs tag_too_long)', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-tag-length-'));
  const library = createLocalLibrary({ dataDir: root });
  t.after(() => { library.close(); rmSync(root, { recursive: true, force: true }); });
  const saved = library.saveContextReference({ title: 'Emoji', content: 'x', tags: ['😀'.repeat(24)] }).item;
  assert.deepEqual(saved.tags, ['😀'.repeat(24)]);
  assert.throws(() => library.saveContextReference({ title: 'Too long', content: 'x', tags: ['😀'.repeat(25)] }), /48 characters/);
});
