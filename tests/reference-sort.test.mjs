import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, openSync, ftruncateSync, closeSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { sortReferences } from '../src/lib/reference-sort.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-order-'));
  const library = createLocalLibrary({ dataDir: join(root, 'library'), browserEnabled: false });
  const db = new DatabaseSync(join(root, 'library', 'stashdock.sqlite3'));
  t.after(() => { db.close(); library.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, library, db };
}
function seed(library, db, count = 65) {
  library.importItems(Array.from({ length: count }, (_, i) => ({ id: `draft-${i}`, title: `Page ${i}`, kind: 'web', source: 'example.com', url: `https://example.com/${i}`, excerpt: 'reference', tags: ['Work'] })));
  const rows = db.prepare('SELECT id FROM stash_items ORDER BY rowid').all();
  const update = db.prepare('UPDATE stash_items SET created_at=? WHERE id=?');
  rows.forEach((row, i) => update.run(new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), row.id));
  return rows.map(row => row.id);
}
test('shelf orders the entire matching library before pagination and shares its saved order', async t => {
  const { root, library, db } = fixture(t), ids = seed(library, db);
  assert.equal(library.getSort(), 'newest');
  assert.equal(library.readShelf().items[0].id, ids[64]);
  assert.equal(library.readShelf({ offset: 30 }).items[0].id, ids[34]);
  library.setSort('oldest');
  assert.equal(library.readShelf().items[0].id, ids[0]);
  library.recordUse([ids[0], ids[1], ids[1]], 'accepted-batch');
  library.recordUse([ids[0], ids[1]], 'accepted-batch');
  library.recordUse([ids[0]], 'accepted-again');
  library.setSort('newest');
  assert.equal(library.readShelf().items[0].id, ids[64], 'Using an older reference does not move it under Recently added');
  library.setSort('most-used');
  assert.deepEqual(library.readShelf({ query: 'Page', tag: 'Work', limit: 2 }).items.map(row => [row.id, row.useCount]), [[ids[0], 2], [ids[1], 1]]);
  const secondHost = createLocalLibrary({ dataDir: join(root, 'library'), browserEnabled: false });
  try { assert.equal(secondHost.getSort(), 'most-used'); assert.equal(secondHost.readShelf().items[0].id, ids[0]); }
  finally { secondHost.close(); }
  assert.equal((await library.read())[0].useCount, 2);
  assert.throws(() => library.setSort('title'), /valid reference order/);
});
test('preparation and reads never count use; accepted batches deduplicate IDs and ignore deleted references', t => {
  const { library, db } = fixture(t), ids = seed(library, db, 2);
  library.readShelf(); library.readItems(ids);
  assert.equal(library.readShelf().items[0].useCount, 0);
  library.recordUse([...ids, ids[0], 'missing'], 'accepted');
  assert.deepEqual(library.readShelf().items.map(row => row.useCount), [1, 1]);
  library.removeMany([ids[0]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reference_usage').get().count, 1);
  assert.throws(() => library.recordUse(ids, ''), /Invalid reference usage/);
  for (let i = 0; i < 1050; i++) library.recordUse(['missing'], `bounded-${i}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reference_usage_receipts').get().count, 1024);
});
test('new references and batches are first by default; use-count ties keep newest first', () => {
  const rows = [{ id: 'old', createdAt: '2026-10-01', useCount: 2 }, { id: 'new-a', createdAt: '2026-11-01' }, { id: 'new-b', createdAt: '2026-11-01' }];
  assert.deepEqual(sortReferences(rows).map(row => row.id), ['new-a', 'new-b', 'old']);
  assert.deepEqual(sortReferences(rows, 'most-used').map(row => row.id), ['old', 'new-a', 'new-b']);
  assert.deepEqual(rows.map(row => row.id), ['old', 'new-a', 'new-b']);
});
test('native video imports above the former limit keep bytes on disk, follow edits and enforce 512 MB', async t => {
  const { root, library } = fixture(t);
  const path = join(root, 'Recording.mp4');
  const sparse = (name, size) => { const fd = openSync(name, 'w'); try { ftruncateSync(fd, size); } finally { closeSync(fd); } };
  sparse(path, 32 * 1024 * 1024);
  const [chosen] = library.describeChosenFiles([path]);
  assert.equal(chosen.mimeType, 'video/mp4'); assert.equal(chosen.content, '');
  assert.ok(JSON.stringify(chosen).length < 300); assert.ok(!JSON.stringify(chosen).includes(root));
  let ticked = false; setImmediate(() => { ticked = true; });
  const [row] = await library.importChosenFiles([{ token: chosen.token, title: 'Recording', content: '' }], []);
  assert.ok(ticked, 'disk copy yields to MCP requests');
  assert.equal(statSync(row.assetPath).size, chosen.size); assert.ok(!row.content);
  writeFileSync(path, 'updated video bytes'); utimesSync(path, 2000000000, 2000000000);
  assert.equal(library.resolveFile(row.id).sizeBytes, 19);
  const oversized = join(root, 'Too large.mp4'); sparse(oversized, 512 * 1024 * 1024 + 1);
  assert.throws(() => library.describeChosenFiles([oversized]), /512 MB/);
});
