// Reproducible isolated comparison. No live data, accounts or network access.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const source = resolve(process.argv[2] || '.');
const count = Number(process.argv[3] || 200);
if (!Number.isSafeInteger(count) || count < 30 || count > 10_000) throw Error('Use between 30 and 10000 fixture references.');
const { createLocalLibrary } = await import(pathToFileURL(join(source, 'plugins/stashdock/server/local-library.mjs')));
const { previewQueue } = await import(pathToFileURL(join(source, 'plugins/stashdock/server/preview-worker.mjs')));
const { searchReferenceIds } = await import(pathToFileURL(join(source, 'plugins/stashdock/server/search-index.mjs')));
const { migrateNoteFiles } = await import(pathToFileURL(join(source, 'plugins/stashdock/server/note-files.mjs')));
const root = mkdtempSync(join(tmpdir(), 'stashdock-stage-perf-'));
let library, db, q;
try {
  library = createLocalLibrary({ dataDir: root });
  db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  const insert = db.prepare(`INSERT INTO stash_items(id,title,kind,source,excerpt,tags_json,created_at,updated_at,asset_path,content,mime_type,size_bytes,preview,origin_json) VALUES(?,?,'note','Note','','[]','2026-10-17','2026-10-17',?,?,'text/plain',?,?,'{}')`);
  const body = 'Context content.\n'.repeat(1024), cover = 'data:image/jpeg;base64,' + 'YQ=='.repeat(30_000);
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const file = join(root, 'assets', `note-${i}.txt`); writeFileSync(file, body);
    insert.run(String(i), `Note ${i}`, file, body, Buffer.byteLength(body), cover);
  }
  db.exec('COMMIT');
  const elapsed = [], queries = [], indexes = [], noteChecks = [], indexedSearches = [];
  let responseBytes = 0;
  for (let i = 0; i < 8; i++) {
    const start = performance.now();
    let result;
    if (library.readShelf) result = library.readShelf({ limit: 30 });
    else { const { search } = await import(pathToFileURL(join(source, 'plugins/stashdock/server/library.mjs'))); result = search(await library.read(), { limit: 30 }); }
    elapsed.push(performance.now() - start);
    assert.equal(result.items.length, 30);
    assert.ok(result.items.every(item => item.content == null && item.assetPath == null));
    responseBytes = Buffer.byteLength(JSON.stringify(result));
    if (library.readShelf) {
      const queryStart = performance.now();
      assert.equal(library.readShelf({ query: 'Context content', limit: 30 }).items.length, 30);
      queries.push(performance.now() - queryStart);
      const indexStart = performance.now();
      const index = library.readIndex();
      assert.equal(index.length, count);
      assert.ok(index.every(item => item.preview == null && item.content == null));
      indexes.push(performance.now() - indexStart);
      const noteStart = performance.now();
      migrateNoteFiles(db, join(root, 'assets'));
      noteChecks.push(performance.now() - noteStart);
      const ftsStart = performance.now();
      assert.equal(searchReferenceIds(db, 'Context content').length, count);
      indexedSearches.push(performance.now() - ftsStart);
    }
  }
  const firstVisualReadMs = elapsed[0];
  let clock = 100;
  q = previewQueue(root, { owner: 'benchmark', now: () => clock }); q.renew(); q.claim();
  const version = () => db.prepare('PRAGMA data_version').get().data_version;
  let previous = version(), commits = 0;
  const start = performance.now();
  for (let i = 0; i < 100; i++) { clock += 2; q.renew(); q.claim(); const current = version(); if (current !== previous) commits++; previous = current; }
  elapsed.sort((a, b) => a - b);
  const median = values => values.length ? Number([...values].sort((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(2)) : null;
  console.log(JSON.stringify({ source, fixtureNotes: count, noteBodyBytes: Buffer.byteLength(body), syntheticCoverBytes: Buffer.byteLength(cover),
    firstVisualReadMs: Number(firstVisualReadMs.toFixed(2)), unchangedVisualReadMedianMs: Number(elapsed[4].toFixed(2)), unchangedVisualReadMaxMs: Number(elapsed[7].toFixed(2)),
    textSearchMedianMs: median(queries), indexReadMedianMs: median(indexes), pageResponseBytes: responseBytes,
    unchangedNoteCheckMedianMs: median(noteChecks), indexedSearchMedianMs: median(indexedSearches),
    idle100ChecksMs: Number((performance.now()-start).toFixed(2)), idleLeaseCommits: commits, maxResidentMB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    scope: 'Node library process only; synthetic cover payloads, no UI/image decoding or WebKit processes', realLibraryWrites: 0 }));
} finally { q?.close(); db?.close(); library?.close(); rmSync(root, { recursive: true, force: true }); }
