// Files chosen in the system dialog are saved as references to their originals
// (see original-files.mjs). Choosing only stages short-lived tokens; the App
// never sends a path, and Save is a separate, explicit action.
// Mirrors src-tauri/src/library/chosen_files.rs; keep them in step.
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint, isTextMime, readText } from './original-files.mjs';

const TOKEN_LIFETIME = 60 * 60 * 1000, MAX_TOKENS = 200, MAX_FILES = 10;
// Same bounds as chosen_files.rs. Native imports never send file bytes through the App.
const MAX_FILE_BYTES = 512 * 1024 * 1024, MAX_BATCH_BYTES = 1024 * 1024 * 1024, STAGED_CHARACTERS = 50_000;

// Same table as Rust's file_kind.
const KINDS = {
  mp4: ['file', 'video/mp4'], mov: ['file', 'video/quicktime'], webm: ['file', 'video/webm'], avi: ['file', 'video/x-msvideo'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], svg: ['image', 'image/svg+xml'], pdf: ['pdf', 'application/pdf'],
  docx: ['file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], doc: ['file', 'application/msword'],
  xlsx: ['file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['file', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  md: ['file', 'text/markdown'], mdx: ['file', 'text/markdown'], txt: ['file', 'text/plain'], log: ['file', 'text/plain'],
  json: ['file', 'application/json'], csv: ['file', 'text/csv'], toml: ['file', 'text/x-toml'], yaml: ['file', 'text/yaml'], yml: ['file', 'text/yaml'],
  xml: ['file', 'application/xml'], html: ['file', 'text/html'], htm: ['file', 'text/html'], css: ['file', 'text/css'],
  js: ['file', 'text/javascript'], mjs: ['file', 'text/javascript'], cjs: ['file', 'text/javascript'], ts: ['file', 'text/typescript'], tsx: ['file', 'text/typescript'],
  jsx: ['file', 'text/jsx'], rs: ['file', 'text/x-rust'], py: ['file', 'text/x-python'], go: ['file', 'text/x-go'], java: ['file', 'text/x-java-source'],
  c: ['file', 'text/x-c'], h: ['file', 'text/x-c'], cpp: ['file', 'text/x-c'], cc: ['file', 'text/x-c'], cxx: ['file', 'text/x-c'], hpp: ['file', 'text/x-c'],
  sql: ['file', 'text/x-sql'], sh: ['file', 'text/x-shellscript'], bash: ['file', 'text/x-shellscript'], ps1: ['file', 'text/x-powershell'],
};
export const fileKind = name => KINDS[extname(name).slice(1).toLowerCase()] || ['file', 'application/octet-stream'];
const staged = (path, mime) => isTextMime(mime) ? Array.from(readText(path) || '').slice(0, STAGED_CHARACTERS).join('') : '';
const formatSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createChosenFiles() {
  const chosen = new Map();
  const remember = path => {
    const now = Date.now();
    for (const [token, value] of chosen) if (now - value.at >= TOKEN_LIFETIME) chosen.delete(token);
    if (chosen.size >= MAX_TOKENS) chosen.delete(chosen.keys().next().value);
    const token = randomUUID(); chosen.set(token, { path, at: now }); return token;
  };
  const pathFor = token => {
    const value = typeof token === 'string' && chosen.get(token);
    if (!value || Date.now() - value.at >= TOKEN_LIFETIME) throw Error('Choose the files again.');
    return value.path;
  };
  return {
    describe(paths) {
      if (!Array.isArray(paths) || paths.length > MAX_FILES) throw Error('Choose up to 10 files at a time.');
      let total = 0;
      return paths.map(raw => {
        let path, stat;
        try { path = realpathSync(raw); stat = statSync(path); } catch { throw Error('A chosen file could not be read.'); }
        if (!stat.isFile()) throw Error('Choose files, not folders.');
        if (stat.size > MAX_FILE_BYTES) throw Error('Choose files up to 512 MB each.');
        total += stat.size;
        if (total > MAX_BATCH_BYTES) throw Error('Choose files up to 1 GB in total.');
        const [, mimeType] = fileKind(path);
        return { content: staged(path, mimeType), token: remember(path), name: basename(path), size: stat.size, mimeType };
      });
    },
    /** Copies each chosen original into the library and returns rows for insert(). */
    async prepare(drafts, assets, raster) {
      if (!Array.isArray(drafts) || !drafts.length || drafts.length > MAX_FILES) throw Error('Choose 1 to 10 files.');
      const inputs = drafts.map(draft => {
        if (typeof draft?.title !== 'string' || !draft.title.trim() || draft.title.length > 500 || typeof draft.content !== 'string' || Array.from(draft.content).length > STAGED_CHARACTERS) throw Error('Check the file title and content, then retry.');
        return { draft, original: pathFor(draft.token) };
      });
      const written = [];
      let total = 0;
      const rows = [];
      try {
        for (const { draft, original } of inputs) {
          const current = fingerprint(original);
          if (!current) throw Error('A chosen file is no longer available. Choose it again.');
          if (current.size > MAX_FILE_BYTES) throw Error('Choose files up to 512 MB each.');
          total += current.size;
          if (total > MAX_BATCH_BYTES) throw Error('Choose files up to 1 GB in total.');
          const name = Array.from(basename(original)).slice(0, 150).join('').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
          const folder = join(assets, randomUUID()); mkdirSync(folder, { recursive: true }); written.push(folder);
          const backup = join(folder, name);
          await copyFile(original, backup);
          const [kind, mimeType] = fileKind(original);
          // Unedited text stays derived from the file and follows later edits.
          const edited = draft.content !== staged(backup, mimeType);
          const content = edited ? draft.content || null : isTextMime(mimeType) ? readText(backup) : null;
          const image = kind === 'image' && current.size <= 20_000_000 ? raster(`data:${mimeType};base64,${readFileSync(backup).toString('base64')}`) : undefined;
          rows.push({ kind, title: draft.title.trim(), content, preview: draft.preview, image, backup, original, mimeType, size: current.size,
            excerpt: content ? Array.from(content.split(/\s+/).filter(Boolean).join(' ')).slice(0, 180).join('') : `${mimeType} · ${formatSize(current.size)}`,
            origin: { platform: 'Local file', importMethod: 'local_file', fileName: name, originalFingerprint: current, ...(edited ? { contentEdited: true } : {}) } });
        }
        return rows;
      } catch (error) { for (const folder of written) rmSync(folder, { recursive: true, force: true }); throw error; }
    },
  };
}
