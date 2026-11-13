// Shared on-disk library, independent of any desktop window or HTTP service.
import { repairMovedBackups } from './asset-paths.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openFilePath, resolveManagedFile } from './open-file.mjs';
import { synchronizeOriginal } from './original-files.mjs';
import { createChosenFiles } from './chosen-files.mjs';
import { migrateNoteFiles } from './note-files.mjs';
import { customCapturePlatform } from '../../../src/lib/captureSites.ts';
import { canonicalReferenceUrl } from '../../../src/lib/reference-url.mjs';
import { LOCATION_KEY, resolveLibraryDirectory } from './library-location.mjs';
import { CODEX_PREFERENCES_KEY, readCodexPreferences, patchCodexPreferences } from './settings.mjs';
import { readIntegrations, installationRecord, browserInstallationRecord, registeredBrowserOrigin } from './integrations.mjs';
import { locateLibrary, markLibraryReady } from './canonical-library.mjs';
import { normalizeContextSave } from './ai-context.mjs';
import { browserCaptureStore } from './browser-capture.mjs';
import { createShelfReader } from './shelf-read.mjs';
import { tagRevision } from './library.mjs';
import { prepareSearchIndex, searchReferenceIds } from './search-index.mjs';
import { readLibrarySort, saveLibrarySort, annotateUsage, orderLibraryItems, recordReferenceUse } from './library-usage.mjs';

/** Desktop's pinned tag list (library.rs PINNED_TAGS_KEY). */
const PINNED_TAGS_KEY = 'desktop_pinned_tags_v1';

export function dataDirectory(env = process.env, platform = process.platform, home = homedir()) {
  if (env.STASHDOCK_DATA_DIR) return resolve(env.STASHDOCK_DATA_DIR);
  const base = platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(base, 'app.stashdock.desktop');
}
export function canonicalUrl(raw) {
  return canonicalReferenceUrl(raw);
}
function tags(values) {
  if (!Array.isArray(values) || values.length > 12 || values.some(value => typeof value !== 'string' || value.trim().length > 48)) throw new Error('Use at most 12 tags, each up to 48 characters.');
  const seen = new Set();
  return values.map(value => value.trim()).filter(value => value && !seen.has(value.toLowerCase()) && seen.add(value.toLowerCase()));
}
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const raster = value => typeof value === 'string' && value.length <= 750_000 && /^data:image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=]+$/i.test(value) ? value : null;
const coverRaster = value => {
  if (!raster(value) || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) throw Error('Use a prepared PNG, JPG or WebP cover image.');
  return value;
};
function fromRow(row) {
  const origin = row.origin_json ? JSON.parse(row.origin_json) : undefined;
  const file = row.kind !== 'note';
  return { id: row.id, title: row.title, kind: row.kind, source: row.source, url: row.url || undefined,
    excerpt: row.excerpt, tags: JSON.parse(row.tags_json), createdAt: row.created_at, favorite: Boolean(row.favorite),
    preview: row.preview || undefined, assetPath: (file && row.asset_path) || undefined, originalPath: (file && row.original_path) || undefined,
    mimeType: (file && row.mime_type) || undefined, hasFile: file && Boolean(row.has_file || row.asset_path), sizeBytes: file ? row.size_bytes ?? undefined : undefined, content: row.content ?? undefined, contextOverride: row.context_override ?? undefined,
    useCount: row.use_count || 0, origin };
}

export function createLocalLibrary({ dataDir, browserEnabled } = {}) {
  const registration = dataDir === undefined ? locateLibrary(dataDirectory(), join(dataDirectory({ ...process.env, STASHDOCK_DATA_DIR: undefined }), 'library-root-v1.json')) : null;
  dataDir = registration?.anchor ?? dataDir;
  let library = openLocalLibrary({ dataDir: resolveLibraryDirectory(dataDir), browserEnabled });
  if (registration) markLibraryReady(registration);
  let closed = false;
  function current() {
    if (closed) throw Error('The library is closed.');
    if (library.relocated()) {
      const root = resolveLibraryDirectory(library.dataDir);
      const next = openLocalLibrary({ dataDir: root, browserEnabled });
      library.close(); library = next;
    }
    return library;
  }
  // Calls saved by capture/MCP handlers follow the new library too. Nothing
  // retries a failed mutation, which could otherwise duplicate an import.
  return new Proxy({}, { get(_target, property) {
    if (property === 'close') return () => { if (!closed) { closed = true; library.close(); } };
    const value = current()[property];
    return typeof value === 'function' ? (...args) => current()[property](...args) : value;
  } });
}
function openLocalLibrary({ dataDir, browserEnabled }) {
  const root = resolve(dataDir), assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  const db = new DatabaseSync(join(root, 'stashdock.sqlite3'));
  db.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  const columns = new Set(db.prepare('PRAGMA table_info(stash_items)').all().map(row => row.name));
  for (const column of ['content', 'origin_json', 'context_override']) if (!columns.has(column)) db.exec(`ALTER TABLE stash_items ADD COLUMN ${column} TEXT`);
  if (!columns.has('preview_version')) db.exec('ALTER TABLE stash_items ADD COLUMN preview_version INTEGER NOT NULL DEFAULT 0');
  db.exec(readFileSync(new URL('../server/preview-version.sql', import.meta.url), 'utf8'));
  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  repairMovedBackups(db, assets);
  transaction(() => {
    prepareSearchIndex(db);
    // An empty plugin library is a real library, not a request for desktop seeds.
    db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES (?,?)').run('library_initialized_v1', '1');
  });
  const get = id => {
    migrateNoteFiles(db, assets, id);
    const row = db.prepare('SELECT stash_items.*,COALESCE(u.use_count,0) AS use_count FROM stash_items LEFT JOIN reference_usage u ON u.id=stash_items.id WHERE stash_items.id=?').get(id);
    if (!row) throw new Error('This reference no longer exists. Refresh the shelf.');
    return fromRow(row);
  };
  // Changed originals refresh their backup before AI reads them. A reference
  // without an original, or with neither file reachable, keeps its saved text.
  const refreshOriginal = id => {
    if (!db.prepare("SELECT 1 FROM stash_items WHERE id=? AND kind<>'note' AND COALESCE(original_path,'')!='' AND COALESCE(asset_path,'')!=''").get(id)) return;
    try { synchronizeOriginal(db, assets, id); } catch { /* Report through the file tools instead. */ }
  };
  const listCapturePlatforms = () => JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='capture_platforms_v1'").get()?.value || '[]');
  const getCodexPreferences = () => readCodexPreferences(db.prepare('SELECT value FROM app_meta WHERE key=?').get(CODEX_PREFERENCES_KEY)?.value);
  const integrations = () => readIntegrations(key => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value);
  const desktopExecutable = () => {
    try { return JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='installation_desktop_v1'").get()?.value || 'null')?.path; } catch { return undefined; }
  };
  const readMeta = key => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
  const registerInstallation = (id, version, path, extensionId, origin) => {
    const record = origin
      ? browserInstallationRecord(readMeta, id, version, extensionId, origin, browserEnabled)
      : installationRecord(id, version, path, extensionId);
    db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(record.key, record.value);
  };
  const saveCodexPreferences = patch => transaction(() => {
    const next = patchCodexPreferences(getCodexPreferences(), patch);
    db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CODEX_PREFERENCES_KEY, JSON.stringify(next));
    return next;
  });
  const saveCapturePlatform = url => transaction(() => {
    const value = customCapturePlatform(url), values = listCapturePlatforms();
    if (!values.some(platform => platform.url === value.url)) {
      if (values.length >= 50) throw Error('You can save up to 50 custom platforms.');
      values.push(value);
      db.prepare("INSERT INTO app_meta(key,value) VALUES ('capture_platforms_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(values));
    }
    return values;
  });
  function annotatePreviews(items) {
    const until = Number(db.prepare("SELECT value FROM app_meta WHERE key='web_preview_worker_until'").get()?.value || 0);
    const imageLive=until>Date.now()/1000 && db.prepare("SELECT 1 FROM sqlite_master WHERE name='web_preview_jobs'").get();
    const contentUntil=Number(db.prepare("SELECT value FROM app_meta WHERE key='web_content_worker_until'").get()?.value||0);
    const status = imageLive ? db.prepare('SELECT status,retry_at,attempts FROM web_preview_jobs WHERE id=? AND url=?') : null;
    const content = contentUntil>Date.now()/1000 && db.prepare("SELECT 1 FROM sqlite_master WHERE name='web_content_jobs'").get() ? db.prepare(`SELECT COALESCE(j.status,'queued') status FROM stash_items s LEFT JOIN web_content_jobs j ON j.id=s.id AND j.url=s.url
      WHERE s.id=? AND s.url=? AND s.context_override IS NULL
      AND COALESCE(json_extract(CASE WHEN json_valid(s.origin_json) THEN s.origin_json ELSE '{}' END,'$.contentSettled'),0)!=1
      AND ((COALESCE(trim(s.content),'')='' AND COALESCE(json_extract(CASE WHEN json_valid(s.origin_json) THEN s.origin_json ELSE '{}' END,'$.contentEdited'),0)!=1)
        OR json_extract(CASE WHEN json_valid(s.origin_json) THEN s.origin_json ELSE '{}' END,'$.pendingTitle')=s.title)
      AND json_extract(CASE WHEN json_valid(s.origin_json) THEN s.origin_json ELSE '{}' END,'$.importMethod') IN ('browser_bookmarks','manual_url')`) : null;
    for (const item of items) {
      if (['web','repo'].includes(item.kind) && item.url) item.contentStatus = content?.get(item.id,item.url)?.status;
      if (!status || item.preview || !['web', 'repo'].includes(item.kind) || !item.url) continue;
      try {
        const url = new URL(item.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) continue;
      } catch { continue; }
      const job = status.get(item.id, item.url), state = job?.status;
      // After a failed first screenshot the default cover shows at once; the one
      // background retry replaces it only on success, without a loading state.
      // Mirrors preview_status in src-tauri/src/web_preview.rs.
      item.previewStatus = !state || state === 'queued' ? 'queued' : state === 'working' && job.retry_at > Date.now()/1000 && job.attempts < 2 ? 'working' : ['retry', 'working', 'failed'].includes(state) ? 'failed' : 'unavailable';
    }
    return items;
  }
  function insert(raw, managed = {}, knownUrls) {
    if (!raw || !['web', 'repo', 'note', 'file', 'pdf', 'image'].includes(raw.kind) || !text(raw.title, 500)) throw new Error('Each reference needs a title and a supported kind.');
    if (['file', 'pdf', 'image'].includes(raw.kind) && !managed.assetPath) throw new Error('Use the file importer to save a managed file.');
    const url = raw.url ? canonicalUrl(raw.url) : null;
    if (['web', 'repo'].includes(raw.kind) && !url) throw new Error('Web references need an http or https URL.');
    if (url) {
      const existing = knownUrls?.get(url) || (!knownUrls && db.prepare('SELECT id,url FROM stash_items WHERE url IS NOT NULL').all().find(row => { try { return canonicalUrl(row.url) === url; } catch { return false; } }));
      if (existing) {
        // Capture retries may enrich images, but never overwrite user edits.
        const current = get(existing.id), origin = { ...current.origin };
        if (raw.origin?.faviconUrl) origin.faviconUrl = text(raw.origin.faviconUrl, 32768);
        const preview = current.origin?.previewSource === 'custom' ? null : raster(raw.preview);
        const capturedBody = raw.origin?.importMethod === 'browser_extension' && !current.content?.trim()
          && current.contextOverride === undefined ? text(raw.content, 20_000) || null : null;
        if (capturedBody) for (const key of ['author','publishedAt','captureMethod','truncated']) {
          if (raw.origin[key] !== undefined) origin[key] = raw.origin[key];
        }
        if (preview && raw.origin?.previewKind) origin.previewKind = raw.origin.previewKind;
        const updated = Boolean(capturedBody || (preview && preview !== current.preview) || JSON.stringify(origin) !== JSON.stringify(current.origin || {}));
        if (updated) {
          db.prepare('UPDATE stash_items SET preview=COALESCE(?,preview),content=COALESCE(?,content),origin_json=?,updated_at=? WHERE id=?')
            .run(preview, capturedBody, JSON.stringify(origin), new Date().toISOString(), existing.id);
        }
        return { item: get(existing.id), duplicate: true, updated };
      }
    }
    const id = randomUUID(), now = new Date().toISOString();
    const origin = raw.origin && typeof raw.origin === 'object' && !Array.isArray(raw.origin) ? { ...raw.origin } : {};
    delete origin.assetPath; delete origin.originalPath;
    origin.importedAt = now;
    db.prepare(`INSERT INTO stash_items(id,title,kind,source,url,excerpt,tags_json,created_at,favorite,preview,asset_path,original_path,mime_type,size_bytes,content,origin_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, text(raw.title, 500), raw.kind, text(raw.source, 300) || 'StashDock', url,
        text(raw.excerpt, 2000), JSON.stringify(tags(raw.tags || [])), Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : now,
        raw.favorite === true ? 1 : 0, raster(raw.preview), managed.assetPath || null, managed.originalPath || null, managed.mimeType || null,
        managed.sizeBytes ?? null, (managed.assetPath || raw.kind === 'note') && typeof raw.content === 'string' ? raw.content : text(raw.content || (raw.kind === 'note' ? raw.excerpt : ''), 2_000_000) || null,
        JSON.stringify(origin), now);
    knownUrls?.set(url, { id, url });
    return { item: get(id), duplicate: false };
  }
  // Explicit Replace uses the new reference, rather than merging prior edits.
  const replaceLink = raw => transaction(() => {
    const url = raw?.url ? canonicalUrl(raw.url) : null;
    const existing = url && db.prepare('SELECT id,url FROM stash_items WHERE url IS NOT NULL').all().find(row => { try { return canonicalUrl(row.url) === url; } catch { return false; } });
    if (!existing) throw new Error('The reference changed. Save the page again.');
    if (!['web', 'repo'].includes(raw.kind) || !text(raw.title, 500)) throw new Error('Each reference needs a title and a supported kind.');
    const origin = raw.origin && typeof raw.origin === 'object' && !Array.isArray(raw.origin) ? { ...raw.origin } : {};
    delete origin.assetPath; delete origin.originalPath;
    origin.importedAt = new Date().toISOString();
    const preview = raster(raw.preview);
    db.prepare('UPDATE stash_items SET title=?,kind=?,source=?,url=?,excerpt=?,tags_json=?,content=?,preview=?,origin_json=?,context_override=NULL,favorite=0,asset_path=NULL,original_path=NULL,mime_type=NULL,size_bytes=NULL,updated_at=? WHERE id=?')
      .run(text(raw.title, 500), raw.kind, text(raw.source, 300) || 'StashDock', url, text(raw.excerpt, 2000), JSON.stringify(tags(raw.tags || [])),
        text(raw.content || '', 2_000_000) || null, preview, JSON.stringify(origin), new Date().toISOString(), existing.id);
    return get(existing.id);
  });
  const importItems = items => {
    if (!Array.isArray(items) || !items.length || items.length > 500) throw new Error('Import between 1 and 500 references at a time.');
    return transaction(() => {
      const knownUrls = new Map();
      for (const row of db.prepare('SELECT id,url FROM stash_items WHERE url IS NOT NULL').all()) { try { knownUrls.set(canonicalUrl(row.url), row); } catch { /* Legacy invalid URL. */ } }
      const results = items.map(item => insert(item, {}, knownUrls));
      return { imported: results.filter(result => !result.duplicate).length, skipped: results.filter(result => result.duplicate && !result.updated).length,
        updated: results.filter(result => result.updated).length, total: results.length, items: results.map(result => result.item) };
    });
  };
  const saveContextReference = raw => {
    const { input, kind, fingerprint } = normalizeContextSave(raw);
    return transaction(() => {
      const key = `ai_context_save_v1:${fingerprint}`;
      const previous = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
      let existing = previous && db.prepare('SELECT id FROM stash_items WHERE id=?').get(previous);
      if (!existing && input.url) existing = db.prepare('SELECT id,url FROM stash_items WHERE url IS NOT NULL').all()
        .find(row => { try { return canonicalUrl(row.url) === input.url; } catch { return false; } });
      if (existing) {
        const item = get(existing.id);
        return { status: 'already_saved', created: false, item,
          contentMatches: (item.content || '') === input.content,
          message: 'Already saved. Existing title, tags and content were kept.' };
      }
      const result = insert({ ...input, kind, source: input.url ? new URL(input.url).hostname : 'AI conversation',
        excerpt: Array.from(input.content.replace(/\s+/g, ' ')).slice(0, 180).join(''),
        createdAt: new Date().toISOString(), origin: { platform: 'AI conversation', importMethod: 'ai_context',
          contentOrigin: input.contentOrigin, sourceUrls: input.sourceUrls } });
      db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, result.item.id);
      return { status: 'saved', created: true, contentMatches: true, item: result.item };
    });
  };
  const setFavorite = (id, favorite) => transaction(() => {
    get(id); if (typeof favorite !== 'boolean') throw new Error('Favorite must be true or false.');
    db.prepare('UPDATE stash_items SET favorite=?,updated_at=? WHERE id=?').run(favorite ? 1 : 0, new Date().toISOString(), id);
    return get(id);
  });
  const setTags = (ids, values) => transaction(() => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 30) throw new Error('Select 1 to 30 references.');
    const value = tags(values); ids.forEach(get);
    for (const id of new Set(ids)) { db.prepare('UPDATE stash_items SET tags_json=?,updated_at=? WHERE id=?').run(JSON.stringify(value), new Date().toISOString(), id); }
    return ids.map(get);
  });
  const applyTagChanges = changes => {
    if (!Array.isArray(changes) || !changes.length || changes.length > 30) throw new Error('Apply tag changes to 1 to 30 references at a time.');
    const seenIds = new Set();
    const prepared = changes.map(change => {
      if (!change || typeof change !== 'object' || typeof change.id !== 'string' || !change.id ||
        typeof change.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(change.expectedRevision)) {
        throw new Error('Each tag change needs a reference ID and its latest tag revision.');
      }
      if (seenIds.has(change.id)) throw new Error('Include each reference only once per tag change batch.');
      seenIds.add(change.id);
      const addTags = tags(change.addTags || []), removeTags = tags(change.removeTags || []);
      if (!addTags.length && !removeTags.length) throw new Error('Each tag change must add or remove at least one tag.');
      const additions = new Set(addTags.map(value => value.toLowerCase()));
      if (removeTags.some(value => additions.has(value.toLowerCase()))) throw new Error('The same tag cannot be added and removed in one change.');
      return { id: change.id, expectedRevision: change.expectedRevision, addTags, removeTags };
    });
    return transaction(() => {
      const results = [];
      for (const change of prepared) {
        let current;
        try { current = get(change.id); }
        catch (error) {
          if (error instanceof Error && error.message.includes('no longer exists')) {
            results.push({ id: change.id, status: 'conflict', reason: 'missing' }); continue;
          }
          throw error;
        }
        const currentRevision = tagRevision(current);
        if (currentRevision !== change.expectedRevision) {
          results.push({ id: change.id, status: 'conflict', reason: 'changed', tags: current.tags, tagRevision: currentRevision }); continue;
        }
        const removed = new Set(change.removeTags.map(value => value.toLowerCase()));
        const next = current.tags.filter(value => !removed.has(value.toLowerCase()));
        const present = new Set(next.map(value => value.toLowerCase()));
        for (const value of change.addTags) if (!present.has(value.toLowerCase())) { next.push(value); present.add(value.toLowerCase()); }
        const normalized = tags(next);
        if (normalized.length === current.tags.length && normalized.every((value, index) => value === current.tags[index])) {
          results.push({ id: change.id, status: 'unchanged', tags: current.tags, tagRevision: currentRevision }); continue;
        }
        db.prepare('UPDATE stash_items SET tags_json=?,updated_at=? WHERE id=?').run(JSON.stringify(normalized), new Date().toISOString(), change.id);
        const updated = get(change.id);
        results.push({ id: change.id, status: 'updated', tags: updated.tags, tagRevision: tagRevision(updated) });
      }
      return {
        updated: results.filter(result => result.status === 'updated').length,
        unchanged: results.filter(result => result.status === 'unchanged').length,
        conflicts: results.filter(result => result.status === 'conflict').length,
        results,
      };
    });
  };
  const editMetadata = (id, title, values, cover) => transaction(() => {
    const current = get(id);
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 500) throw new Error('Use a title between 1 and 500 characters.');
    const value = tags(values);
    if (current.origin?.pendingTitle !== undefined) {
      delete current.origin.pendingTitle;
      db.prepare('UPDATE stash_items SET origin_json=? WHERE id=?').run(JSON.stringify(current.origin),id);
    }
    db.prepare('UPDATE stash_items SET title=?,tags_json=?,updated_at=? WHERE id=?').run(title.trim(), JSON.stringify(value), new Date().toISOString(), id);
    if (cover !== undefined) {
      const origin = { ...current.origin };
      let preview;
      if (cover.preview !== null) {
        preview = coverRaster(cover.preview); origin.previewKind = 'cover'; origin.previewSource = 'custom';
      } else {
        preview = cover.defaultPreview ? coverRaster(cover.defaultPreview) : null;
        delete origin.previewKind; delete origin.previewSource;
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='web_preview_jobs'").get()) db.prepare('DELETE FROM web_preview_jobs WHERE id=?').run(id);
      }
      db.prepare('UPDATE stash_items SET preview=?,origin_json=? WHERE id=?').run(preview, JSON.stringify(origin), id);
    }
    return get(id);
  });
  const defaultCover = id => {
    const item = get(id);
    if (item.kind !== 'image' || !item.assetPath) return null;
    const { path, sizeBytes } = resolveManagedFile(item.assetPath, assets);
    if (sizeBytes > 5_000_000) throw Error('The saved image is unavailable.');
    return readFileSync(path).toString('base64');
  };
  const editContext = (id, context) => transaction(() => {
    get(id);
    if (typeof context !== 'string' || context.length > 200_000) throw new Error('Use at most 200,000 characters.');
    db.prepare('UPDATE stash_items SET context_override=?,updated_at=? WHERE id=?').run(context, new Date().toISOString(), id);
    return get(id);
  });
  const changeTag = (name, replacement) => transaction(() => {
    const normalized = tags([name])[0], next = replacement === null ? null : tags([replacement])[0];
    if (!normalized || (replacement !== null && !next)) throw new Error('Enter a tag name.');
    for (const row of db.prepare('SELECT id,tags_json FROM stash_items').all()) {
      const before = JSON.parse(row.tags_json);
      if (!before.some(tag => tag.toLowerCase() === normalized.toLowerCase())) continue;
      const after = tags(before.flatMap(tag => tag.toLowerCase() === normalized.toLowerCase() ? next ? [next] : [] : [tag]));
      db.prepare('UPDATE stash_items SET tags_json=?,updated_at=? WHERE id=?').run(JSON.stringify(after), new Date().toISOString(), row.id);
    }
    // Desktop's pinned tags follow the rename/removal in the same transaction
    // (library.rs change_tag), so they never point at a tag that is gone.
    const pinned = db.prepare('SELECT value FROM app_meta WHERE key=?').get(PINNED_TAGS_KEY)?.value;
    if (pinned) {
      let list = [];
      try { list = JSON.parse(pinned); } catch { list = []; }
      const seen = new Set();
      const updated = (Array.isArray(list) ? list : []).flatMap(tag => typeof tag !== 'string' ? [] : tag.toLowerCase() === normalized.toLowerCase() ? next ? [next] : [] : [tag])
        .filter(tag => !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
      db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES (?,?)').run(PINNED_TAGS_KEY, JSON.stringify(updated));
    }
    return { changed: true };
  });
  const removeMany = ids => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10_000 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 120)) throw new Error('Select between 1 and 10,000 valid references.');
    const { deleted, backups } = transaction(() => {
      const asset = db.prepare("SELECT asset_path FROM stash_items WHERE id=? AND COALESCE(asset_path,'')!=''");
      const items = db.prepare('DELETE FROM stash_items WHERE id=?');
      let deleted = 0; const backups = [];
      for (const id of new Set(ids)) { const path = asset.get(id)?.asset_path; if (path) backups.push(path); deleted += items.run(id).changes; }
      const shared = db.prepare('SELECT 1 FROM stash_items WHERE asset_path=? LIMIT 1');
      return { deleted, backups: backups.filter(path => !shared.get(path)) };
    });
    // Deleting a reference removes StashDock's managed copy, never the user's
    // original file. Only paths inside the library's assets folder are touched.
    for (const raw of backups) {
      try {
        const { path } = resolveManagedFile(raw, assets);
        unlinkSync(path);
        const parent = dirname(path);
        if (parent !== realpathSync(assets)) try { rmdirSync(parent); } catch { /* Not empty. */ }
      } catch { /* Already gone or outside the library. */ }
    }
    return { deleted };
  };
  const remove = id => ({ deleted: removeMany([id]).deleted > 0 });
  const chosenFiles = createChosenFiles();
  const importChosenFiles = async (drafts, selectedTags) => {
    const explicitTags = selectedTags === undefined ? undefined : tags(selectedTags);
    const rows = await chosenFiles.prepare(drafts, assets, raster);
    try {
      if (db.prepare('SELECT value FROM app_meta WHERE key=?').get(LOCATION_KEY)) throw Error('The library location changed. Choose the files again.');
      return transaction(() => rows.map(row => insert({ title: row.title, kind: row.kind, source: 'Local file', excerpt: row.excerpt,
        tags: explicitTags ?? [row.kind === 'image' ? 'Image' : row.kind === 'pdf' ? 'PDF' : 'File'], content: row.content,
        preview: row.preview ?? row.image, origin: { ...row.origin, ...(row.preview ? { previewKind: 'cover', previewSource: 'custom' } : {}) } },
        { assetPath: row.backup, originalPath: row.original, mimeType: row.mimeType, sizeBytes: row.size }).item));
    } catch (error) { for (const row of rows) rmSync(dirname(row.backup), { recursive: true, force: true }); throw error; }
  };
  const importFiles = (files, selectedTags) => {
    const explicitTags = selectedTags === undefined ? undefined : tags(selectedTags);
    if (!Array.isArray(files) || !files.length || files.length > 10) throw new Error('Import 1 to 10 files at a time.');
    let total = 0;
    const inputs = files.map(file => {
      if (typeof file.base64 === 'string' && file.base64.length > 6_666_668) throw new Error('Files must be under 5 MB each and 10 MB per import.');
      if (typeof file.name !== 'string' || !file.name.trim() || typeof file.base64 !== 'string' || file.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error('The file data is invalid.');
      const bytes = Buffer.from(file.base64, 'base64'); total += bytes.length;
      if (bytes.toString('base64') !== file.base64) throw new Error('The file data is invalid.');
      if (bytes.length > 5_000_000 || total > 10_000_000) throw new Error('Files must be under 5 MB each and 10 MB per import.');
      const name = basename(file.name.replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 150) || 'reference';
      const extension = name.split('.').pop().toLowerCase();
      const mime = ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }[extension]) || 'application/octet-stream';
      if (file.title !== undefined && (!text(file.title,500) || file.title.length > 500)) throw Error('Add a file title under 500 characters.');
      if (file.content !== undefined && (typeof file.content !== 'string' || file.content.length > 50_000)) throw Error('Use content under 50,000 characters.');
      return { bytes, name, mime, title: file.title, editedContent: file.content, preview: file.preview === undefined ? undefined : coverRaster(file.preview) };
    });
    const written = [];
    try { return transaction(() => inputs.map(({ bytes, name, mime, title, editedContent, preview }) => {
      const assetPath = join(assets, `${randomUUID()}-${name}`);
      writeFileSync(assetPath, bytes, { flag: 'wx' }); written.push(assetPath);
      const kind = mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : 'file';
      const extracted = mime.startsWith('text/') || /\.(md|txt|csv|json|html|css|js|ts|py)$/i.test(name) ? bytes.toString('utf8').slice(0, 2_000_000) : undefined;
      const staged = Array.from(extracted || '').slice(0, 50_000).join('');
      const content = editedContent ?? extracted;
      return insert({ title: title?.trim() || name, kind, source: 'Local file', excerpt: content ? content.replace(/\s+/g,' ').slice(0,180) : `${mime} · ${Math.ceil(bytes.length / 1024)} KB`,
        tags: explicitTags ?? [kind === 'image' ? 'Image' : kind === 'pdf' ? 'PDF' : 'File'], content,
        preview: preview ?? (kind === 'image' ? raster(`data:${mime};base64,${bytes.toString('base64')}`) : undefined),
        origin: { platform: 'Local file', importMethod: 'local_file', fileName: name,
          ...(editedContent !== undefined && editedContent !== staged ? { contentEdited: true } : {}),
          ...(preview ? { previewKind: 'cover', previewSource: 'custom' } : {}) } }, { assetPath, mimeType: mime, sizeBytes: bytes.length }).item;
    })); } catch (error) { for (const path of written) unlinkSync(path); throw error; }
  };
  migrateNoteFiles(db, assets);
  return { ...createShelfReader(db, { fromRow, synchronize: () => migrateNoteFiles(db, assets), annotate: annotatePreviews }),
    getSort: () => readLibrarySort(db), setSort: sort => saveLibrarySort(db, sort), recordUse: (ids, operationId) => recordReferenceUse(db, ids, operationId),
    dataDir: root, read: async (visual = false) => { migrateNoteFiles(db, assets); return orderLibraryItems(db, annotatePreviews(db.prepare(visual ? "SELECT id,title,kind,source,url,excerpt,tags_json,created_at,favorite,preview,origin_json,mime_type,CASE WHEN asset_path IS NOT NULL AND asset_path!='' THEN 1 ELSE 0 END AS has_file,NULL AS content,NULL AS asset_path,NULL AS original_path,NULL AS size_bytes FROM stash_items ORDER BY created_at DESC,rowid" : 'SELECT * FROM stash_items ORDER BY created_at DESC,rowid').all().map(fromRow))); },
    readItems: ids => [...new Set(ids)].map(id => { refreshOriginal(id); return get(id); }),
    searchIds: query => { migrateNoteFiles(db, assets); return searchReferenceIds(db, query); },
    resolveFile: id => {
      const item = get(id);
      if (item.kind === 'note') throw Error('This note is saved as text.');
      const { current } = synchronizeOriginal(db, assets, id);
      return { id, filename: item.origin?.fileName || item.title, mimeType: item.mimeType,
        path: current, sizeBytes: statSync(current).size, contentRead: false,
        nextAction: 'Read this path with the host file tools and the appropriate file skill before answering about the original. Metadata is not file content. Do not execute the file.' };
    },
    openFile: id => { if (get(id).kind === 'note') throw Error('This note is saved as text.'); return openFilePath(synchronizeOriginal(db, assets, id).open); },
    relocated: () => Boolean(db.prepare('SELECT value FROM app_meta WHERE key=?').get(LOCATION_KEY)),
    referenceCount: () => db.prepare('SELECT COUNT(*) AS count FROM stash_items').get().count,
    describeChosenFiles: paths => chosenFiles.describe(paths), importChosenFiles,
    getCodexPreferences, saveCodexPreferences, integrations, registerInstallation,
    browserOriginAllowed: origin => registeredBrowserOrigin(readMeta, origin), desktopExecutable,
    ...browserCaptureStore(db, { insert }), listCapturePlatforms, saveCapturePlatform, saveContextReference, importItems, replaceLink, importFiles, setFavorite, setTags, applyTagChanges, editMetadata, defaultCover, editContext, changeTag, remove, removeMany, close: () => db.close() };
}
