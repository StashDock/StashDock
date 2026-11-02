// Stage the same plugin identity with its verified Mac runtime. No user data.
import { cp, mkdir, readFile, readdir, lstat, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Package and verify this runtime on an Apple Silicon Mac.');
const root = resolve(import.meta.dirname, '..');
const platform = 'darwin-arm64';
const source = resolve(root, 'output/plugin-build', platform, 'plugins/stashdock');
const metadata = JSON.parse(await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'scripts/node-runtime-darwin-arm64-lock.json'), 'utf8'));
const destination = resolve(process.argv[2] || resolve(root, 'output/releases', `stashdock-plugin-${metadata.version}-${platform}`));
for (const path of [destination, destination + '.zip']) {
  let exists = true; try { await access(path); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (exists) throw Error('Package already exists. Choose a new destination.');
}
if (source === destination || source.startsWith(destination + sep) || destination.startsWith(source + sep)) throw Error('Package destination must be outside the build stage.');
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
if (await sha(join(source, 'bin', platform, 'node')) !== lock.sha256) throw Error('Bundled Node checksum mismatch.');
const target = join(destination, 'plugins/stashdock');
await mkdir(target, { recursive: true });
for (const name of ['.codex-plugin', 'assets', 'dist', 'notices', 'scripts', 'skills', 'web', '.mcp.json']) await cp(join(source, name), join(target, name), { recursive: true });
await mkdir(join(target, 'server'), { recursive: true });
for (const name of ['schema.sql', 'search-index.sql', 'preview-version.sql']) await cp(join(source, 'server', name), join(target, 'server', name));
await cp(join(source, 'bin', platform), join(target, 'bin', platform), { recursive: true });
await mkdir(join(destination, '.agents/plugins'), { recursive: true });
await cp(resolve(root, '.agents/plugins/marketplace.json'), join(destination, '.agents/plugins/marketplace.json'));
for (const name of ['LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md']) {
  await cp(resolve(root, name), join(destination, name));
  await cp(resolve(root, name), join(target, name));
}
await mkdir(join(target, 'licenses'), { recursive: true });
await cp(resolve(root, 'licenses/StashDock-legacy-MIT.txt'), join(target, 'licenses/StashDock-legacy-MIT.txt'));
await cp(resolve(root, 'docs/macos-plugin-install.md'), join(destination, 'README.md'));
for (const path of ['StashDockRenderer.app', 'stashdock-preview', 'stashdock-storage', 'stashdock-browser', 'node']) {
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', join(target, 'bin', platform, path)], { stdio: 'inherit' });
  if (result.status !== 0) throw Error('Packaged native signature is invalid.');
}
const records = [];
async function inventory(directory) {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry), info = await lstat(path);
    if (info.isSymbolicLink()) throw Error('A plugin package must not contain symlinks.');
    if (info.isDirectory()) await inventory(path);
    else {
      if (!info.isFile() || /\.(?:sqlite3?|db)(?:-.*)?$|\.(?:pdb|map|dmp|p12|key)$/i.test(path)) throw Error('Unexpected development or private artifact in package.');
      records.push({ path: relative(destination, path).split(sep).join('/'), bytes: info.size, sha256: await sha(path) });
    }
  }
}
await inventory(destination);
await writeFile(join(destination, 'RELEASE_MANIFEST.json'), JSON.stringify({ formatVersion: 1, platform, version: metadata.version, node: lock.version, notarized: false, files: records }, null, 2) + '\n');
const zip = spawnSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', destination, destination + '.zip'], { stdio: 'inherit' });
if (zip.status !== 0) throw Error('Mac plugin archive failed.');
console.log(JSON.stringify({ folder: destination, zip: destination + '.zip', sha256: await sha(destination + '.zip') }));
