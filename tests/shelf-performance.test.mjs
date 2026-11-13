import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { search } from '../plugins/stashdock/server/library.mjs';

test('paged shelf keeps filter/search/tag semantics without reading unrelated covers or file bodies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-shelf-perf-'));
  const library = createLocalLibrary({ dataDir: root });
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  try {
    for (let n = 0; n < 42; n++) library.importItems([{ title: `Web ${n}`, kind: 'web', source: 'Site', url: `https://example.org/${n}`, tags: [n % 2 ? 'Odd' : 'Even'], content: `Body ${n}`, preview: 'data:image/png;base64,YQ==', favorite: n % 3 === 0 }]);
    const note = library.saveContextReference({ title: 'Shared file', content: 'Old original', tags: ['Even'] }).item;
    db.prepare('UPDATE stash_items SET content=? WHERE id=?').run('New externally saved original', note.id);
    const plain = library.readShelf({ limit: 30 });
    assert.equal(plain.items.length, 30); assert.equal(plain.hasMore, true);
    assert.equal(plain.tags.find(t => t.name === 'Even').count, 22);
    for (const row of plain.items) { assert.equal(row.content, undefined); assert.equal(row.assetPath, undefined); assert.equal(row.contextOverride, undefined); }
    assert.ok(library.readIndex().every(row => !row.preview && !row.content && !row.assetPath));
    for (const args of [{ limit: 7, offset: 7 }, { collection: 'files' }, { collection: 'web', tag: 'odd' }, { favoriteOnly: true }, { query: 'Body 3' }, { query: 'New externally saved' }]) {
      const actual = library.readShelf(args), expected = search(await library.read(), { limit: 30, sort: library.getSort(), ...args, rankedIds: library.searchIds(args.query) ?? undefined });
      assert.deepEqual(actual.items.map(row => row.id), expected.items.map(row => row.id));
      assert.equal(actual.hasMore, expected.hasMore);
      if (args.query?.startsWith('New')) assert.deepEqual(actual.items.map(row => row.id), [note.id]);
    }
    // No write transaction (or file projection scan) for passive page refresh.
    db.exec('BEGIN IMMEDIATE');
    try { assert.equal(library.readShelf({ limit: 30 }).items.length, 30); }
    finally { db.exec('ROLLBACK'); }
    library.setFavorite(note.id, true);
    assert.equal(library.readShelf({ collection: 'favorites' }).items.find(item => item.id === note.id).favorite, true);
    library.remove(note.id);
    assert.equal(library.readShelf({ collection: 'files' }).items.length, 0);
  } finally { db.close(); library.close(); rmSync(root, { recursive: true, force: true }); }
});
