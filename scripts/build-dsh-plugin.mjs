import { build } from 'esbuild';
import { cp, mkdir, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'plugins/stashdock-dsh');
const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
if (!['win32-x64', 'darwin-arm64'].includes(platform)) throw Error('Build on a supported desktop platform.');
const windows = process.platform === 'win32';
const shared = resolve(root, windows ? 'plugins/stashdock' : `output/plugin-build/${platform}/plugins/stashdock`);
const output = resolve(root, 'output/dsh', platform);
const stage = resolve(output, 'bundle');
const runtime = resolve(stage, 'runtime');
await mkdir(resolve(runtime, 'bin', platform), { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) await cp(resolve(source, file), resolve(stage, file));
for (const file of ['web/shelf.html', 'dist/mcp-server.mjs', 'assets/icon.png', 'skills/use-stashdock/SKILL.md',
  'server/schema.sql', 'server/search-index.sql', 'server/preview-version.sql', 'LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md',
  'licenses', 'notices']) {
  await cp(resolve(shared, file), resolve(runtime, file), { recursive: true });
}
for (const name of ['stashdock-browser', 'stashdock-preview', 'stashdock-storage', ...windows ? [] : ['StashDockRenderer.app']]) {
  const file = windows ? `${name}.exe` : name;
  await cp(resolve(shared, 'bin', platform, file), resolve(runtime, 'bin', platform, file), { recursive: true });
}
await build({
  entryPoints: [resolve(source, 'host.mjs')], outfile: resolve(stage, 'index.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  minify: true, keepNames: true, legalComments: 'eof',
  external: ['./runtime/dist/mcp-server.mjs'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
await build({
  entryPoints: [resolve(source, 'client.mjs')], outfile: resolve(stage, 'client.js'),
  bundle: true, format: 'cjs', platform: 'browser', external: ['react'], loader: { '.png': 'dataurl' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
});
const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--quiet', '--pack-destination', output], {
  cwd: stage, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true,
});
if (packed.error) throw packed.error;
if (packed.status !== 0) throw Error('The DSH plugin could not be packed.');
const archive = resolve(output, `${manifest.name}-${manifest.version}-${platform}.tgz`);
await rename(resolve(output, `${manifest.name}-${manifest.version}.tgz`), archive);
console.log(archive);
