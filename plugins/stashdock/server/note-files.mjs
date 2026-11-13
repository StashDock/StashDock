// Import legacy Note TXT bodies once. Keep the old files available for recovery.
import { openSync, readSync, closeSync } from 'node:fs';
import { resolveManagedFile } from './open-file.mjs';
import { fingerprint } from './original-files.mjs';

const MAX_TEXT_BYTES = 5_000_000;
function readLegacyText(path, assets) {
  let descriptor;
  try {
    const file = resolveManagedFile(path, assets);
    if (file.sizeBytes > MAX_TEXT_BYTES) return;
    const before = fingerprint(file.path);
    descriptor = openSync(file.path, 'r');
    const buffer = Buffer.alloc(file.sizeBytes + 1);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(descriptor, buffer, length, buffer.length - length, null))) length += count;
    const after = fingerprint(file.path);
    if (length !== file.sizeBytes || !before || !after || before.size !== after.size || before.modifiedMs !== after.modifiedMs) return;
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)), path: file.path, fingerprint: after };
  } catch { return; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function migrateNoteFiles(db, assets, id) {
  const query = db.prepare(`SELECT id,asset_path,origin_json FROM stash_items
    WHERE kind='note' AND asset_path<>''${id === undefined ? '' : ' AND id=?'}`);
  const rows = id === undefined ? query.all() : query.all(id);
  let candidates = [], bytes = 0;
  for (const row of rows) {
    const text = readLegacyText(row.asset_path, assets);
    if (!text) continue;
    const length = Buffer.byteLength(text.content);
    if (candidates.length >= 64 || bytes + length > 8_000_000) {
      migrateBatch(db, candidates);
      candidates = []; bytes = 0;
    }
    candidates.push({ ...row, ...text }); bytes += length;
  }
  migrateBatch(db, candidates);
}

function migrateBatch(db, candidates) {
  if (!candidates.length) return;
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare("SELECT origin_json FROM stash_items WHERE id=? AND kind='note' AND asset_path=?");
    const save = db.prepare(`UPDATE stash_items SET asset_path=NULL,original_path=NULL,mime_type=NULL,size_bytes=NULL,
      content=?,excerpt=?,origin_json=? WHERE id=?`);
    for (const candidate of candidates) {
      const row = current.get(candidate.id, candidate.asset_path);
      const latest = fingerprint(candidate.path);
      if (!row || !latest || latest.size !== candidate.fingerprint.size || latest.modifiedMs !== candidate.fingerprint.modifiedMs) continue;
      let origin;
      try { origin = JSON.parse(row.origin_json || '{}'); } catch { origin = {}; }
      if (!origin || typeof origin !== 'object' || Array.isArray(origin)) origin = {};
      delete origin.fileName;
      delete origin.fileFingerprint;
      const { content } = candidate;
      save.run(content, Array.from(content.replace(/\s+/g, ' ')).slice(0, 180).join(''), JSON.stringify(origin), candidate.id);
    }
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
