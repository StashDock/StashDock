import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { fingerprint, synchronizeOriginal } from '../plugins/stashdock/server/original-files.mjs';

// Same scenarios as src-tauri/src/library/originals.rs.
function fixture(t, text = 'alpha', fingerprinted = true) {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-originals-'));
  const library = createLocalLibrary({ dataDir: root });
  const assets = join(root, 'assets');
  mkdirSync(join(assets, 'item'), { recursive: true });
  const original = join(root, 'Notes.md'), managed = join(assets, 'item', 'Notes.md');
  writeFileSync(original, text); writeFileSync(managed, text);
  utimesSync(original, 1000, 1000); utimesSync(managed, 1000, 1000);
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  // Windows cannot remove a folder while SQLite holds files in it: close first.
  t.after(() => { db.close(); library.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,asset_path,original_path,mime_type,size_bytes,content,origin_json,updated_at)
    VALUES('item','Notes.md','file','Local file','','[]','now',?,?,'text/markdown',?,?,?,'now')`)
    .run(managed, original, text.length, text, JSON.stringify(fingerprinted ? { originalFingerprint: fingerprint(original) } : {}));
  return { root, assets, db, library, original: realpathSync(original), managed: realpathSync(managed) };
}

test('an unchanged original opens itself and transfers the backup', t => {
  const f = fixture(t);
  assert.deepEqual(synchronizeOriginal(f.db, f.assets, 'item'), { current: f.managed, open: f.original });
});

test('an edited original refreshes the backup, its text and search before AI reads it', t => {
  const f = fixture(t);
  writeFileSync(f.original, 'bravo updated'); utimesSync(f.original, 2000, 2000);
  const [item] = f.library.readItems(['item']);
  assert.equal(item.content, 'bravo updated');
  assert.equal(readFileSync(f.managed, 'utf8'), 'bravo updated');
  assert.deepEqual(f.library.searchIds('updated'), ['item']);
  assert.equal(f.library.resolveFile('item').path, f.managed);
  assert.equal(f.library.resolveFile('item').sizeBytes, 13);
});

test('user-written import text is kept while the file bytes refresh', t => {
  const f = fixture(t);
  f.db.exec(`UPDATE stash_items SET content='my words', origin_json=json_set(origin_json,'$.contentEdited',json('true'))`);
  writeFileSync(f.original, 'bravo'); utimesSync(f.original, 2000, 2000);
  synchronizeOriginal(f.db, f.assets, 'item');
  assert.equal(readFileSync(f.managed, 'utf8'), 'bravo');
  assert.equal(f.db.prepare('SELECT content FROM stash_items').get().content, 'my words');
});

test('a missing original falls back to the backup; a missing backup is restored from the original', t => {
  const f = fixture(t);
  unlinkSync(f.managed);
  assert.deepEqual(synchronizeOriginal(f.db, f.assets, 'item'), { current: f.managed, open: f.original });
  assert.equal(readFileSync(f.managed, 'utf8'), 'alpha');
  unlinkSync(f.original);
  assert.deepEqual(synchronizeOriginal(f.db, f.assets, 'item'), { current: f.managed, open: f.managed });
});

test('a legacy backup edited after its original stays authoritative', t => {
  const f = fixture(t, 'alpha', false);
  writeFileSync(f.managed, 'edited backup'); utimesSync(f.managed, 3000, 3000);
  assert.deepEqual(synchronizeOriginal(f.db, f.assets, 'item'), { current: f.managed, open: f.managed });
  assert.equal(readFileSync(f.managed, 'utf8'), 'edited backup');
});

test('an original of another type is ignored and a backup outside the library is refused', t => {
  const f = fixture(t);
  const other = join(f.root, 'Notes.exe'); writeFileSync(other, 'x');
  f.db.prepare('UPDATE stash_items SET original_path=?').run(other);
  assert.equal(synchronizeOriginal(f.db, f.assets, 'item').open, f.managed);
  f.db.prepare('UPDATE stash_items SET asset_path=?').run(join(f.root, 'elsewhere.md'));
  assert.throws(() => synchronizeOriginal(f.db, f.assets, 'item'));
});

test('deleting references removes only their library backups', t => {
  const f = fixture(t);
  const shared = join(f.assets, 'shared.txt'), outside = join(f.root, 'outside.txt');
  writeFileSync(shared, 'x'); writeFileSync(outside, 'x');
  const insert = f.db.prepare(`INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,asset_path,updated_at) VALUES(?,?,'file','Local file','','[]','now',?,'now')`);
  insert.run('b', 'b', shared); insert.run('c', 'c', shared); insert.run('d', 'd', outside);
  assert.deepEqual(f.library.removeMany(['item', 'b', 'd']), { deleted: 3 });
  assert.throws(() => readFileSync(f.managed), /ENOENT/);
  assert.throws(() => readFileSync(join(f.assets, 'item')), /ENOENT/, 'the empty backup folder is removed');
  assert.equal(readFileSync(f.original, 'utf8'), 'alpha', "the user's original is never touched");
  assert.equal(readFileSync(shared, 'utf8'), 'x', 'a backup still used by another reference stays');
  assert.equal(readFileSync(outside, 'utf8'), 'x', 'paths outside the library are never deleted');
});

test('MCP system-dialog imports reference the original, keep only tokens in the App and follow later edits', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import('../plugins/stashdock/server/create-server.mjs');
  const root = mkdtempSync(join(tmpdir(), 'stashdock-chosen-'));
  const plan = join(root, 'Plan.md'), paper = join(root, 'Paper.pdf');
  writeFileSync(plan, '# Plan\nShip it'); writeFileSync(paper, '%PDF-1.7 bytes');
  const server = createServer({ dataDir: join(root, 'library'), htmlUrl: new URL('../plugins/stashdock/web/shelf.html', import.meta.url),
    storageServices: { chooseFiles: async () => [plan, paper], close() {} } });
  const client = new Client({ name: 'chosen files test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const chosen = (await client.callTool({ name: 'choose_stashdock_files', arguments: {} }))._meta.files;
  assert.deepEqual(chosen.map(file => [file.name, file.content, file.mimeType]), [['Plan.md', '# Plan\nShip it', 'text/markdown'], ['Paper.pdf', '', 'application/pdf']]);
  assert.ok(chosen.every(file => !JSON.stringify(file).includes(root)), 'the App never receives a path');
  const saved = await client.callTool({ name: 'import_stashdock_chosen_files', arguments: { tags: ['Work'], files: [
    { token: chosen[0].token, title: 'Plan', content: chosen[0].content }, { token: chosen[1].token, title: 'Paper', content: 'My summary' }] } });
  assert.equal(saved.isError, undefined, JSON.stringify(saved.content));
  const [planItem, paperItem] = saved.structuredContent.items;
  assert.deepEqual([planItem.kind, paperItem.kind, planItem.tags], ['file', 'pdf', ['Work']]);
  writeFileSync(plan, '# Plan\nShip it on Friday'); utimesSync(plan, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
  const read = await client.callTool({ name: 'get_stashdock_items', arguments: { ids: [planItem.id, paperItem.id] } });
  const text = JSON.stringify(read.structuredContent);
  assert.match(text, /Ship it on Friday/, 'unedited text follows the original');
  assert.match(text, /My summary/, 'user-written text is kept');
  const bogus = await client.callTool({ name: 'import_stashdock_chosen_files', arguments: { files: [{ token: 'not-a-token', title: 'x', content: '' }] } });
  assert.equal(bogus.isError, true);
});

test('a library copied elsewhere finds its backups again (same cases as asset_paths.rs)', async t => {
  const { tailAfterAssets } = await import('../plugins/stashdock/server/asset-paths.mjs');
  const contract = JSON.parse(readFileSync(new URL('./fixtures/asset-paths.json', import.meta.url), 'utf8'));
  for (const { path, tail } of contract.tails) assert.deepEqual(tailAfterAssets(path), tail, path);
  const root = mkdtempSync(join(tmpdir(), 'stashdock-moved-'));
  mkdirSync(join(root, 'assets', 'item'), { recursive: true });
  writeFileSync(join(root, 'assets', 'item', 'Notes.md'), 'x'); writeFileSync(join(root, 'assets', 'flat-Plan.md'), 'x');
  let library = createLocalLibrary({ dataDir: root }); library.close();
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  const insert = db.prepare("INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,asset_path,updated_at) VALUES(?,?,'file','Local file','','[]','now',?,'now')");
  insert.run('windows', 'w', 'D:\\StashDockData\\assets\\item\\Notes.md');
  insert.run('desktop', 'd', '/Users/me/Library/Application Support/app.stashdock.desktop/assets/flat-Plan.md');
  insert.run('gone', 'g', 'D:\\StashDockData\\assets\\other\\Missing.md');
  db.close();
  library = createLocalLibrary({ dataDir: root });
  const check = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  t.after(() => { check.close(); library.close(); rmSync(root, { recursive: true, force: true }); });
  const path = id => check.prepare('SELECT asset_path FROM stash_items WHERE id=?').get(id).asset_path;
  assert.equal(path('windows'), join(root, 'assets', 'item', 'Notes.md'));
  assert.equal(path('desktop'), join(root, 'assets', 'flat-Plan.md'));
  assert.equal(path('gone'), 'D:\\StashDockData\\assets\\other\\Missing.md');
});
