import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const result = await build({ stdin: { contents: "export * from './src/features/library/store'; export * from './src/features/library/selectors'; export * from './src/lib/context';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node' });
const module = { exports: {} };
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports);
const { createLibraryStore, buildSearchIndex, filterItems, selectItems, summarizeItems, buildContext } = module.exports;
const item = (id, overrides = {}) => ({ id, title: id, kind: 'web', source: 'Example', url: `https://example.com/${id}`, excerpt: 'reference', tags: ['Design'], createdAt: new Date().toISOString(), ...overrides });

test('Desktop loads shared ordering, commits menu changes and retains the preference on failed writes', async () => {
  let order = 'oldest', fail = false;
  const store = createLibraryStore({ load: async () => [item('a')], loadSort: async () => order,
    saveSort: async value => { if (fail) throw Error('disk failed'); order = value; }, add: async () => {}, remove: async () => {}, favorite: async () => {} });
  await store.refresh(); assert.equal(store.getSnapshot().sort, 'oldest');
  await store.setSort('most-used'); assert.equal(order, 'most-used');
  fail = true; await assert.rejects(store.setSort('newest'), /disk failed/);
  assert.equal(store.getSnapshot().sort, 'most-used');
  order = 'newest'; await store.refresh(); assert.equal(store.getSnapshot().sort, 'newest');
});

test('confirmed link replacement uses the replacement adapter and the new final context', async () => {
  const old = item('saved', { contextOverride: 'Old final context', content: 'Old body', favorite: true, preview: 'old-cover' });
  let written;
  const store = createLibraryStore({ load: async () => [old], add: async () => assert.fail('An ordinary upsert preserves edited context'),
    replace: async (incoming, next) => { written = incoming; return next; }, remove: async () => {}, favorite: async () => {} });
  await store.refresh();
  await store.replaceLink(item('draft', { url: old.url, title: 'Fresh page', content: 'New body' }));
  assert.equal(written.id, old.id);assert.equal(written.createdAt, old.createdAt);
  assert.equal(written.contextOverride, undefined);assert.equal(written.preview, undefined);assert.equal(written.favorite, false);
  const context = buildContext(store.getSnapshot().items);
  assert.match(context, /New body/);assert.doesNotMatch(context, /Old final context|Old body/);
});

test('import publishes canonical saved assets immediately instead of stale pre-save form objects', async () => {
  const draft = item('note-file', { kind: 'note', url: undefined });
  const saved = { ...draft, assetPath: 'managed/Note.txt', mimeType: 'text/plain' };
  const store = createLibraryStore({ load: async () => [], add: async () => [saved], remove: async () => {}, favorite: async () => {} });
  await store.add([draft]);
  assert.equal(store.getSnapshot().items[0].assetPath, saved.assetPath);
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('bulk deletion commits once, deduplicates IDs and publishes only after success', async () => {
  let calls = 0, notifications = 0;
  const gate = deferred();
  const store = createLibraryStore({ load: async () => [item('a'), item('b'), item('c')], add: async () => {}, remove: async () => {}, favorite: async () => {},
    removeMany: async ids => { calls++; assert.deepEqual(ids, ['a', 'b']); await gate.promise; } });
  await store.refresh(); store.subscribe(() => notifications++);
  const pending = store.removeMany(['a', 'a', 'b']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().items.length, 3); assert.equal(notifications, 0);
  gate.resolve(); await pending;
  assert.equal(calls, 1); assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot().items.map(item => item.id), ['c']);
});
test('a cover update re-reads only the named references, keeps order, drops deleted ones and leaves the rest untouched', async () => {
  let loads = 0; const reads = [];
  const store = createLibraryStore({ load: async () => { loads++; return [item('a'), item('b'), item('c')]; }, add: async () => {}, remove: async () => {}, favorite: async () => {},
    loadSome: async ids => { reads.push(ids); return ids.filter(id => id !== 'c').map(id => item(id, { preview: `stashdock-preview://${id}` })); } });
  await store.refresh(); const before = store.getSnapshot().items;
  await store.patch(['b', 'b', 'c']);
  assert.deepEqual(reads, [['b', 'c']]); assert.equal(loads, 1, 'no whole-library reload');
  const after = store.getSnapshot().items;
  assert.deepEqual(after.map(row => row.id), ['a', 'b']);
  assert.equal(after[0], before[0], 'unchanged references keep their identity');
  assert.equal(after[1].preview, 'stashdock-preview://b');
  // An ID the shelf has not loaded yet falls back to one ordered full reload.
  const unknown = createLibraryStore({ load: async () => { loads++; return [item('a')]; }, add: async () => {}, remove: async () => {}, favorite: async () => {}, loadSome: async () => [item('new')] });
  await unknown.refresh(); loads = 0; await unknown.patch(['new']); await new Promise(resolve => setTimeout(resolve, 0)); await unknown.refresh();
  assert.ok(loads >= 1);
});
test('failed bulk deletion preserves the snapshot and allows retry', async () => {
  let fail = true;
  const store = createLibraryStore({ load: async () => [item('a'), item('b')], add: async () => {}, remove: async () => {}, favorite: async () => {},
    removeMany: async () => { if (fail) throw new Error('disk full'); } });
  await store.refresh(); const before = store.getSnapshot();
  await assert.rejects(store.removeMany(['a', 'b']), /disk full/);
  assert.equal(store.getSnapshot(), before);
  fail = false; await store.removeMany(['a', 'b']); assert.equal(store.getSnapshot().items.length, 0);
});
function fixture(initial = [item('a')]) {
  let data = initial;
  const calls = [];
  const repository = {
    load: async () => { calls.push('load'); return structuredClone(data); },
    add: async (incoming, next) => { calls.push(['add', incoming.map(item => item.id)]); data = next; },
    remove: async (id, next) => { calls.push(['remove', id]); data = next; },
    favorite: async (id, value, next) => { calls.push(['favorite', id, value]); data = next; },
  };
  return { store: createLibraryStore(repository), calls, repository };
}

test('reads are coalesced and never write; equal refreshes preserve item and snapshot identity', async () => {
  const f = fixture();
  const first = f.store.refresh();
  assert.equal(first, f.store.refresh());
  await first;
  const snapshot = f.store.getSnapshot();
  await f.store.refresh();
  assert.equal(f.store.getSnapshot(), snapshot);
  assert.deepEqual(f.calls, ['load', 'load']);
});
test('import invalidation during an in-flight read schedules a fresh read', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture();
  f.repository.load = async () => ++calls === 1 ? gate.promise : [item('new')];
  const refresh = f.store.refresh();
  await new Promise(resolve => setImmediate(resolve));
  void f.store.invalidate(); gate.resolve([item('old')]);
  await refresh;
  assert.equal(calls, 2);
  assert.deepEqual(f.store.getSnapshot().items.map(item => item.id), ['new']);
});
test('queued mutations deduplicate IDs and canonical URLs against the newest snapshot', async () => {
  const f = fixture(); await f.store.refresh();
  const first = f.store.add([item('b')]);
  const duplicate = f.store.add([item('c', { url: 'https://example.com/b?utm_source=test#reply' })]);
  assert.deepEqual(await first, { imported: 1, skipped: 0 });
  assert.deepEqual(await duplicate, { imported: 0, skipped: 1 });
  assert.deepEqual(f.calls, ['load', ['add', ['b']]]);
});
test('favorite updates write only one ID and deleted items cannot be reinserted by a later toggle', async () => {
  const f = fixture(); await f.store.refresh();
  await Promise.all([f.store.toggleFavorite('a'), f.store.remove('a'), f.store.toggleFavorite('a')]);
  assert.deepEqual(f.calls, ['load', ['favorite', 'a', true], ['remove', 'a']]);
  assert.deepEqual(f.store.getSnapshot().items, []);
});
test('a failed mutation leaves shared data unchanged and does not poison the queue', async () => {
  const f = fixture(); await f.store.refresh(); const snapshot = f.store.getSnapshot();
  f.repository.favorite = async () => { throw new Error('write failed'); };
  await assert.rejects(f.store.toggleFavorite('a'), /write failed/);
  assert.equal(f.store.getSnapshot(), snapshot);
  await f.store.add([item('b')]);
  assert.equal(f.store.getSnapshot().items.length, 2);
});
test('native file imports already persisted by Rust do not write a second time', async () => {
  const f = fixture(); await f.store.refresh();
  await f.store.add([item('file')], true);
  assert.deepEqual(f.calls, ['load']);
  assert.equal(f.store.getSnapshot().items.length, 2);
});
test('multiple surfaces share changes and unsubscribe independently', async () => {
  const f = fixture(); let a = 0, b = 0;
  const stop = f.store.subscribe(() => a++); f.store.subscribe(() => b++);
  await f.store.refresh(); stop(); await f.store.toggleFavorite('a');
  assert.equal(a, 1); assert.equal(b, 2);
  f.store.announceImport({ imported: 1, updated: 0, skipped: 0 });
  assert.equal(f.store.getSnapshot().importNotice.message, 'Page saved from browser.');
});
test('search and tag filters share cached text; FTS order uses current canonical items', () => {
  const items = [item('a', { content: 'deep context' }), item('b', { favorite: true }), item('c', { kind: 'pdf', tags: ['Paper'] })];
  const index = buildSearchIndex(items);
  assert.deepEqual(filterItems(items, index, 'DEEP', 'all').map(item => item.id), ['a']);
  assert.deepEqual(filterItems(items, index, '', 'files').map(item => item.id), ['c']);
  assert.deepEqual(filterItems(items, index, '', 'favorites', 'Design').map(item => item.id), ['b']);
  const ranked = filterItems(items, index, 'ranked', 'all', null, new Set(['b', 'a', 'missing']));
  assert.equal(ranked[0], items[1]); assert.equal(ranked[1], items[0]);
  assert.deepEqual(selectItems(items, ['b', 'missing', 'a']), [items[1], items[0]]);
  assert.equal(summarizeItems(items).counts.files, 1);
});
test('views cannot autosave loaded snapshots; hidden library searches pause', async () => {
  const controller = await readFile(resolve(root, 'src/features/library/useLibraryController.ts'), 'utf8');
  assert.doesNotMatch(controller, /saveItems|listen\(/);
  assert.match(controller, /if \(!active \|\| !storageReady/);
});

test('metadata edits validate input, preserve other fields and publish only after persistence', async () => {
  const original = item('a', { content: 'body', preview: 'preview', favorite: true });
  const f = fixture([original]); let reject = false;
  f.repository.edit = async (_id, _title, _tags, next) => { if (reject) throw Error('disk failed'); return next; };
  await f.store.refresh();
  await f.store.edit('a', ' New title ', ['Design', 'design', ' Research ']);
  const edited = f.store.getSnapshot().items[0];
  assert.equal(edited.title, 'New title'); assert.deepEqual(edited.tags, ['Design', 'Research']);
  assert.equal(edited.content, 'body'); assert.equal(edited.preview, 'preview'); assert.equal(edited.favorite, true);
  await assert.rejects(f.store.edit('a', ' ', []), /title/);
  await assert.rejects(f.store.edit('a', 'Valid', ['x'.repeat(49)]), /48/);
  reject = true; await assert.rejects(f.store.edit('a', 'Not persisted', []), /disk failed/);
  assert.equal(f.store.getSnapshot().items[0], edited);
});

test('tag rename/remove updates references case-insensitively without removing cards', async () => {
  const f = fixture([item('a', { tags: ['Design', 'Research'] }), item('b', { tags: ['design'] })]);
  f.repository.changeTag = async (_name, _replacement, next) => next;
  await f.store.refresh(); await f.store.changeTag('DESIGN', 'Research');
  assert.ok(f.store.getSnapshot().items.every(item => item.tags.length === 1 && item.tags[0] === 'Research'));
  await f.store.changeTag('research', null);
  assert.equal(f.store.getSnapshot().items.length, 2);
  assert.ok(f.store.getSnapshot().items.every(item => item.tags.length === 0));
});

test('content edits preserve metadata and formatting, update copy and search, and can clear the body', async () => {
  const original = item('a', { content: 'obsoletebody', excerpt: 'obsoletebody', preview: 'preview', favorite: true, assetPath: 'original.md' });
  const f = fixture([original, item('b')]); const pending = deferred();
  f.repository.editContent = async (_id, _content, next) => { await pending.promise; return next; };
  await f.store.refresh(); const before = f.store.getSnapshot();
  const body = '\n# Updated context\n\n  Keep indentation\nnewbodytoken';
  const write = f.store.editContent('a', body);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.store.getSnapshot(), before);
  pending.resolve(); await write;
  const edited = f.store.getSnapshot().items[0];
  assert.equal(edited.contextOverride, body); assert.equal(edited.content, original.content); assert.equal(edited.excerpt, original.excerpt);
  for (const key of ['title', 'tags', 'preview', 'favorite', 'assetPath', 'url', 'createdAt']) assert.deepEqual(edited[key], original[key]);
  assert.equal(f.store.getSnapshot().items[1], before.items[1]);
  assert.ok(buildContext([edited]).includes(body)); assert.ok(!buildContext([edited]).includes('obsoletebody'));
  const index = buildSearchIndex([edited]); assert.equal(filterItems([edited], index, 'newbodytoken', 'all').length, 1);
  await f.store.editContent('a', ''); const cleared = f.store.getSnapshot().items[0];
  assert.equal(cleared.contextOverride, ''); assert.equal(cleared.content, original.content); assert.equal(buildContext([cleared]), '');
});

test('invalid or failed content edits retain the saved body and do not poison later saves', async () => {
  const f = fixture([item('a', { content: 'original' })]); let reject = true;
  f.repository.editContent = async (_id, _content, next) => { if (reject) throw Error('disk failed'); return next; };
  await f.store.refresh(); const before = f.store.getSnapshot();
  await assert.rejects(f.store.editContent('missing', 'body'), /no longer exists/);
  await assert.rejects(f.store.editContent('a', 'x'.repeat(200001)), /200,000/);
  await assert.rejects(f.store.editContent('a', 'unsaved'), /disk failed/);
  assert.equal(f.store.getSnapshot(), before);
  reject = false; await f.store.editContent('a', 'persisted'); assert.equal(f.store.getSnapshot().items[0].contextOverride, 'persisted');
});
