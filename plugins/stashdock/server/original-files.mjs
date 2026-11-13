// A file reference points at the user's original file and keeps a managed
// backup in the library. Before a file is opened, resolved or read for AI, a
// changed original refreshes the backup (and its searchable text). A missing or
// unreachable original silently falls back to the backup.
//
// Mirrors src-tauri/src/library/originals.rs; keep them in step.
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

// Same limit as chosen files; a larger original is used in place, not copied.
const MAX_ORIGINAL_BYTES = 512 * 1024 * 1024;
const TEXT_BYTES = 1024 * 1024, TEXT_CHARACTERS = 200_000;

export function fingerprint(path) {
  try { const stat = statSync(path); return stat.isFile() ? { size: stat.size, modifiedMs: Math.floor(stat.mtimeMs) } : null; }
  catch { return null; }
}
const same = (a, b) => Boolean(a && b && a.size === b.size && a.modifiedMs === b.modifiedMs);
export const isTextMime = mime => mime.startsWith('text/') || ['application/json', 'application/xml', 'image/svg+xml'].includes(mime);
const inside = (root, path) => { const child = relative(root, path); return Boolean(child) && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child); };

export function readText(path) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(TEXT_BYTES);
    const length = readSync(descriptor, buffer, 0, TEXT_BYTES, 0);
    const text = Array.from(buffer.subarray(0, length).toString('utf8')).slice(0, TEXT_CHARACTERS).join('').trim();
    return text || null;
  } finally { closeSync(descriptor); }
}

function availableOriginal(raw, managed) {
  if (typeof raw !== 'string' || !raw || !isAbsolute(raw) || extname(raw).toLowerCase() !== extname(managed).toLowerCase()) return null;
  try { const path = realpathSync(raw); return statSync(path).isFile() ? path : null; } catch { return null; }
}

function managedPath(raw, assets) {
  if (typeof raw !== 'string' || !raw) throw Error('This reference has no saved file.');
  let root;
  try { root = realpathSync(assets); } catch { throw Error('The file library is unavailable.'); }
  try { const path = realpathSync(raw); if (inside(root, path) && statSync(path).isFile()) return path; } catch { /* Backup missing: rebuild below. */ }
  try { const parent = realpathSync(dirname(raw)); if (inside(root, parent) || parent === root) return join(parent, basename(raw)); } catch { /* Outside or gone. */ }
  throw Error('The saved file is unavailable. Restore it before using this reference.');
}

function replaceBackup(original, managed) {
  mkdirSync(dirname(managed), { recursive: true });
  const temporary = join(dirname(managed), `.${randomUUID()}.refresh`);
  try { copyFileSync(original, temporary); renameSync(temporary, managed); return true; }
  catch { try { unlinkSync(temporary); } catch { /* Not created. */ } return false; }
}

/** Returns { current, open }: the path with current bytes and the path Open should show. */
export function synchronizeOriginal(db, assets, id) {
  const row = db.prepare('SELECT asset_path,original_path,origin_json,mime_type FROM stash_items WHERE id=?').get(id);
  if (!row) throw Error('This reference no longer exists. Refresh the shelf.');
  const managed = managedPath(row.asset_path, assets);
  let origin = {};
  try { const value = JSON.parse(row.origin_json || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) origin = value; } catch { /* Legacy metadata. */ }
  const original = availableOriginal(row.original_path, managed);
  const backup = fingerprint(managed);
  if (!original) {
    if (!backup) throw Error('The saved file is unavailable. Restore it before using this reference.');
    return { current: managed, open: managed };
  }
  const current = fingerprint(original);
  if (!current) { const fallback = backup ? managed : original; return { current: fallback, open: fallback }; }
  const recorded = origin.originalFingerprint;
  if (backup && same(recorded, current)) return { current: managed, open: original };
  // Older references have no fingerprint. A backup edited after the original
  // (through the previous Open behaviour) is the user's newer version.
  if (!recorded && backup && backup.modifiedMs > current.modifiedMs) return { current: managed, open: managed };
  if (current.size > MAX_ORIGINAL_BYTES || !replaceBackup(original, managed)) return { current: original, open: original };
  origin.originalFingerprint = current;
  const mime = row.mime_type || '';
  // Text files re-derive their searchable text unless the user wrote it.
  const refresh = origin.contentEdited !== true && isTextMime(mime) ? 1 : 0;
  const content = refresh ? readText(managed) : null;
  db.prepare(`UPDATE stash_items SET size_bytes=?,origin_json=?,updated_at=?,
      content=CASE WHEN ? THEN ? ELSE content END, excerpt=CASE WHEN ? THEN ? ELSE excerpt END WHERE id=?`)
    .run(current.size, JSON.stringify(origin), new Date().toISOString(), refresh, content,
      refresh, Array.from((content || '').split(/\s+/).filter(Boolean).join(' ')).slice(0, 180).join(''), id);
  return { current: managed, open: original };
}
