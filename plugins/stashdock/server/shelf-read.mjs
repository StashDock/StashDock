// One read snapshot, compact search rows, only the visible page's cover blobs.
// Background refresh must not deserialize every original and image in a library.
import { search } from './library.mjs';
import { searchReferenceIds } from './search-index.mjs';
import { readLibrarySort, annotateUsage } from './library-usage.mjs';

export function createShelfReader(db, { fromRow, synchronize, annotate }) {
  const fields = `id,title,kind,source,url,excerpt,tags_json,created_at,favorite,origin_json,mime_type,
    CASE WHEN asset_path IS NOT NULL AND asset_path!='' THEN 1 ELSE 0 END AS has_file`;
  const readIndex = (withContent = false) => {
    if (withContent) synchronize();
    return db.prepare(`SELECT ${fields},${withContent ? 'content,context_override' : 'NULL AS content,NULL AS context_override'} FROM stash_items ORDER BY created_at DESC,rowid`).all().map(fromRow);
  };
  return {
    readIndex,
    readShelf: (args = {}) => {
      // Searching reads note projections; they may write, so finish them before the snapshot.
      if (args.query?.trim()) synchronize();
      db.exec('BEGIN');
      try {
        const rows = db.prepare(`SELECT ${fields},NULL AS content,NULL AS context_override FROM stash_items ORDER BY created_at DESC,rowid`).all().map(fromRow);
        const rankedIds = searchReferenceIds(db, args.query) ?? undefined;
        const sort = args.sort ?? readLibrarySort(db);
        const result = search(annotateUsage(db, rows), { ...args, sort, limit: args.limit ?? 30, rankedIds });
        const image = db.prepare('SELECT preview FROM stash_items WHERE id=?');
        result.items = annotate(result.items.map(row => ({ ...row, preview: image.get(row.id)?.preview || undefined })));
        const counts = new Map();
        for (const row of rows) for (const tag of row.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
        db.exec('COMMIT');
        return { ...result, sort, tags: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })) };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
