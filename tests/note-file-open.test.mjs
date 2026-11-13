import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, constants } from 'node:sqlite';
import { migrateNoteFiles } from '../plugins/stashdock/server/note-files.mjs';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { prepareAttachment } from '../plugins/stashdock/server/library.mjs';

test('modern note checks read metadata only and do not reserve a writer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-note-idle-'));
  const library = createLocalLibrary({ dataDir: root });
  const note = library.saveContextReference({ title: 'Normal context', content: 'Original' }).item;
  const writer = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  t.after(() => { writer.close(); library.close(); rmSync(root, { recursive: true, force: true }); });
  writer.setAuthorizer((action, table, column) => action === constants.SQLITE_READ && table === 'stash_items' &&
    ['content', 'excerpt', 'preview', 'context_override'].includes(column) ? constants.SQLITE_DENY : constants.SQLITE_OK);
  assert.doesNotThrow(() => migrateNoteFiles(writer, join(root, 'assets')));
  writer.setAuthorizer(null);
  writer.exec('BEGIN IMMEDIATE');
  try { assert.equal((await library.read())[0].content, note.content); }
  finally { writer.exec('ROLLBACK'); }
});

test('notes store full text, share edits across providers and create no file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-context-note-'));
  const first = createLocalLibrary({ dataDir: root }), second = createLocalLibrary({ dataDir: root });
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  const body = '完整原文\n'.repeat(6000);
  const note = first.saveContextReference({ title: 'Common rules', content: body, tags: ['Rules'] }).item;
  assert.equal(note.assetPath, undefined); assert.equal(note.hasFile, false);
  assert.equal(prepareAttachment([note], [note.id]).content[0].resource.text.includes(body), true);
  assert.deepEqual(readdirSync(join(root, 'assets')), []);
  assert.throws(() => first.resolveFile(note.id), /unavailable|not a file|saved as text/i);
  first.editContext(note.id, 'Updated from the card');
  let loaded = (await second.read()).find(row => row.id === note.id);
  assert.equal(loaded.content, body); assert.equal(loaded.contextOverride, 'Updated from the card');
  assert.equal(prepareAttachment([loaded], [note.id]).content[0].resource.text, 'Updated from the card');
  first.editContext(note.id, '');
  loaded = (await second.read()).find(row => row.id === note.id);
  assert.equal(prepareAttachment([loaded], [note.id]).content[0].resource.text, '');
});

test('legacy TXT migration retains latest text, identity, metadata, final context and recovery file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-legacy-note-'));
  let library = createLocalLibrary({ dataDir: root });
  const note = library.saveContextReference({ title: 'Legacy note', content: 'Cached body', tags: ['Keep'] }).item;
  library.close();
  const file = join(root, 'assets', 'Legacy.txt');
  writeFileSync(file, '\ufeffLatest externally edited body 中文');
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  db.prepare("UPDATE stash_items SET asset_path=?,mime_type='text/plain',size_bytes=1,context_override='Final user edit',favorite=1 WHERE id=?").run(file, note.id);
  db.prepare('INSERT INTO reference_usage(id,use_count) VALUES(?,3)').run(note.id);
  db.close();
  library = createLocalLibrary({ dataDir: root });
  t.after(() => { library.close(); rmSync(root, { recursive: true, force: true }); });
  let [migrated] = await library.read();
  assert.equal(migrated.id, note.id); assert.equal(migrated.title, 'Legacy note');
  assert.equal(migrated.favorite, true); assert.equal(migrated.useCount, 3); assert.deepEqual(migrated.tags, ['Keep']);
  assert.equal(migrated.content, 'Latest externally edited body 中文');
  assert.equal(migrated.contextOverride, 'Final user edit');
  assert.equal(migrated.assetPath, undefined); assert.equal(migrated.hasFile, false);
  assert.equal(readFileSync(file, 'utf8'), '\ufeffLatest externally edited body 中文');
  writeFileSync(file, 'Recovery copy edited after migration');
  [migrated] = await library.read();
  assert.equal(migrated.content, 'Latest externally edited body 中文');
  assert.equal(prepareAttachment([migrated], [note.id]).content[0].resource.text, 'Final user edit');
  library.removeMany([note.id]);
  assert.equal(readFileSync(file, 'utf8'), 'Recovery copy edited after migration');
});

test('an unavailable legacy TXT retains cached context and can migrate when its file returns', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-note-missing-'));
  const library = createLocalLibrary({ dataDir: root });
  const note = library.saveContextReference({ title: 'Rules', content: 'Cached body' }).item;
  const file = join(root, 'assets', 'Missing.txt');
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  t.after(() => { db.close(); library.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("UPDATE stash_items SET asset_path=?,context_override='' WHERE id=?").run(file, note.id);
  db.exec('BEGIN IMMEDIATE');
  try { assert.equal(library.readItems([note.id])[0].content, 'Cached body'); }
  finally { db.exec('ROLLBACK'); }
  let [loaded] = await library.read();
  assert.equal(loaded.content, 'Cached body'); assert.equal(loaded.contextOverride, '');
  assert.equal(loaded.hasFile, false);
  assert.equal(db.prepare('SELECT asset_path FROM stash_items WHERE id=?').get(note.id).asset_path, file);
  writeFileSync(file, 'Recovered current body');
  [loaded] = await library.read();
  assert.equal(loaded.content, 'Recovered current body'); assert.equal(loaded.contextOverride, '');
  assert.equal(db.prepare('SELECT asset_path FROM stash_items WHERE id=?').get(note.id).asset_path, null);
});

test('a failed upgrade batch rolls back and resumes without losing previous batches or TXT files', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-note-batches-'));
  const library = createLocalLibrary({ dataDir: root });
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  t.after(() => { db.close(); library.close(); rmSync(root, { recursive: true, force: true }); });
  const insert = db.prepare("INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,updated_at,asset_path,content) VALUES(?,?,'note','Note','','[]','now','now',?,'Cached body')");
  for (let n = 0; n < 70; n++) {
    const id = 'note-' + String(n).padStart(3, '0'), path = join(root, 'assets', id + '.txt');
    writeFileSync(path, 'Latest ' + id);
    insert.run(id, id, path);
  }
  db.exec("CREATE TRIGGER stop_note_batch BEFORE UPDATE ON stash_items WHEN NEW.id='note-066' AND NEW.asset_path IS NULL BEGIN SELECT RAISE(ABORT, 'stop migration batch'); END");
  assert.throws(() => migrateNoteFiles(db, join(root, 'assets')), /stop migration batch/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stash_items WHERE asset_path IS NULL').get().count, 64);
  assert.equal(db.prepare("SELECT content FROM stash_items WHERE id='note-066'").get().content, 'Cached body');
  db.exec('DROP TRIGGER stop_note_batch');
  migrateNoteFiles(db, join(root, 'assets'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stash_items WHERE asset_path IS NULL').get().count, 70);
  assert.equal(db.prepare("SELECT content FROM stash_items WHERE id='note-066'").get().content, 'Latest note-066');
  assert.equal(readdirSync(join(root, 'assets')).length, 70);
});

test('all imported formats reopen and transfer the same latest original, with supplemental content separate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-live-original-test-'));
  const library = createLocalLibrary({ dataDir: root });
  t.after(() => { library.close(); rmSync(root, { recursive: true, force: true }); });
  for (const extension of ['txt', 'md', 'pdf', 'png', 'xlsx', 'docx']) {
    const [item] = library.importFiles([{ name: `Original.${extension}`, base64: Buffer.from('Original bytes').toString('base64'), content: 'Supplemental context' }]);
    writeFileSync(item.assetPath, 'Latest file bytes');
    const file = library.resolveFile(item.id);
    assert.equal(file.path, realpathSync(item.assetPath)); assert.equal(readFileSync(file.path, 'utf8'), 'Latest file bytes');
    library.editContext(item.id, 'New supplemental context');
    assert.equal(readFileSync(file.path, 'utf8'), 'Latest file bytes');
  }
});
