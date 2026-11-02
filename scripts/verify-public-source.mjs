// Inspect the exact Git index, not ignored working files. Never print secret values.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
export const sourceRoots = new Set(['.agents','assets','docs','extension','licenses','plugins','public','scripts','shared','safari','src','src-tauri','tests']);
export const rootFiles = new Set(['.gitattributes','.gitignore','README.md','README.zh-CN.md','LICENSE','LICENSING.md','THIRD_PARTY_NOTICES.md','components.json','index.html','package.json','package-lock.json','tsconfig.app.json','tsconfig.json','tsconfig.node.json','vite.config.ts']);
export const publicDocuments = new Set(['docs/INSTALL_WINDOWS.md','docs/windows-plugin-install.md','docs/macos-plugin-install.md','docs/RELEASE_NOTES_v1.0.0.md','docs/RELEASE_NOTES_v1.0.1.md','docs/RELEASE_NOTES_v1.0.2.md','docs/RELEASE_NOTES_v1.0.3.md']);
export function privateSourcePath(path) {
  return /(^|\/)(node_modules|target|output|artifacts|profile|preview-runtime|connection-runtime|build-runtime|pdf-runtime|\.git|\.codex|\.playwright)(\/|$)/i.test(path)
    || /^website\//i.test(path)
    || /^\.github\//.test(path)
    || /^(?:AGENTS|CLAUDE)\.md$|^design\.md$/.test(path)
    || /^\.agents\/(?!plugins\/)/.test(path)
    || /^docs\//.test(path) && !publicDocuments.has(path)
    || /^tests\/(?:website|stage-review|internal-source)/.test(path)
    || /^scripts\/(?:package-mac-handoff\.ps1|verify-handoff\.mjs|README\.md)$/.test(path)
    || /^scripts\/[^/]*website[^/]*$/i.test(path)
    || /^plugins\/stashdock\/bin\//.test(path)
    || /(^|\/)\.env($|\.)|\.(exe|dll|pdb|sqlite3?|sqlite3?-\w+|db|db-\w+|log|pem|pfx|p12|key|zip|dmp)$/i.test(path);
}
export function containsCredential(text) {
  return /gh[pousr]_[a-zA-Z0-9]{25,}|github_pat_[a-zA-Z0-9_]{30,}|\bsk-[a-zA-Z0-9_-]{24,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(text);
}
export function verifyIndex(cwd = resolve(import.meta.dirname, '..')) {
  const entries = execFileSync('git', ['ls-files','--stage','-z'], { cwd, encoding:'utf8', maxBuffer:8*1024*1024 }).split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/.exec(record);
    if (!match || match[3] !== '0') throw Error('Unmerged or invalid index.');
    return { mode:match[1], oid:match[2], path:match[4] };
  });
  if (!entries.length) throw Error('Stage the intended source first.');
  for (const { mode, path } of entries) {
    if (mode !== '100644' && mode !== '100755') throw Error(`Unexpected linked source: ${path}`);
    if (privateSourcePath(path) || !(rootFiles.has(path) || sourceRoots.has(path.split('/')[0]))) throw Error(`Non-public source path: ${path}`);
  }
  const contents = execFileSync('git', ['cat-file','--batch'], { cwd, input:entries.map(e=>e.oid+'\n').join(''), maxBuffer:128*1024*1024 });
  let cursor = 0, bytes = 0;
  for (const entry of entries) {
    const end = contents.indexOf(10, cursor), header = contents.subarray(cursor,end).toString('utf8').split(' ');
    if (header[0] !== entry.oid || header[1] !== 'blob') throw Error(`Invalid staged blob: ${entry.path}`);
    const size = Number(header[2]); cursor = end+1;
    if (!Number.isSafeInteger(size) || size < 0 || size > 90*1024*1024) throw Error(`Oversized source: ${entry.path}`);
    const data = contents.subarray(cursor,cursor+size); cursor += size+1; bytes += size;
    if (data.subarray(0,16).toString('utf8') === 'SQLite format 3\0' || data.subarray(0,2).toString() === 'MZ') throw Error(`Runtime or library in source: ${entry.path}`);
    if (!data.includes(0) && containsCredential(data.toString('utf8'))) throw Error(`Potential credential in staged file (value withheld): ${entry.path}`);
  }
  for (const required of ['package-lock.json','src-tauri/Cargo.lock','.agents/plugins/marketplace.json','plugins/stashdock/skills/use-stashdock/SKILL.md']) {
    if (!entries.some(e=>e.path===required)) throw Error(`Missing public source: ${required}`);
  }
  return { files:entries.length, bytes, privateFilesIncluded:false, credentialPatternMatches:0 };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) console.log(JSON.stringify(verifyIndex(process.argv[2])));
