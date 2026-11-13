import { normalizeReferenceSort, sortReferences } from '../../../src/lib/reference-sort.mjs';

const KEY = 'library_sort_v1';
export const readLibrarySort = db => normalizeReferenceSort(db.prepare('SELECT value FROM app_meta WHERE key=?').get(KEY)?.value);
export function saveLibrarySort(db, sort) {
  if (normalizeReferenceSort(sort) !== sort) throw Error('Choose a valid reference order.');
  db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, sort);
  return sort;
}
export function annotateUsage(db, items) {
  const counts = new Map(db.prepare('SELECT id,use_count FROM reference_usage').all().map(row => [row.id, row.use_count]));
  return items.map(item => ({ ...item, useCount: counts.get(item.id) || 0 }));
}
export const orderLibraryItems = (db, items, sort = readLibrarySort(db)) => sortReferences(annotateUsage(db, items), sort);

/** Called only after a user transfer succeeds. Receipts prevent a retried acknowledgment counting twice. */
export function recordReferenceUse(db, ids, operationId) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10_000 || ids.some(id => typeof id !== 'string' || !id || id.length > 120) ||
      typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(operationId)) throw Error('Invalid reference usage.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const fresh = db.prepare('INSERT OR IGNORE INTO reference_usage_receipts(operation_id) VALUES(?)').run(operationId).changes;
    if (fresh) {
      const increment = db.prepare('INSERT INTO reference_usage(id,use_count) SELECT id,1 FROM stash_items WHERE id=? ON CONFLICT(id) DO UPDATE SET use_count=use_count+1');
      for (const id of new Set(ids)) increment.run(id);
      db.exec('DELETE FROM reference_usage_receipts WHERE rowid <= (SELECT COALESCE(MAX(rowid),0)-1024 FROM reference_usage_receipts)');
    }
    db.exec('COMMIT');
    return { recorded: Boolean(fresh) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
