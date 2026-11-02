import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Shared server/UI; platform executables are staged separately, never forked.
const platform = `${process.platform}-${process.arch}`;
if (!['win32-x64', 'darwin-arm64'].includes(platform)) throw Error('Build and verify the matching preview helper/runtime on this platform before publishing.');
const mac = process.platform === 'darwin';
const sharedPlugin = resolve(root, 'plugins/stashdock');
const plugin = mac ? resolve(root, 'output/plugin-build', platform, 'plugins/stashdock') : sharedPlugin;
if (mac) await rm(plugin, { recursive: true, force: true }); // Fixed generated stage only.
const nodePin = JSON.parse(await readFile(resolve(root, mac ? 'scripts/node-runtime-darwin-arm64-lock.json' : 'scripts/node-runtime-lock.json'), 'utf8'));
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error(`Build command failed: ${command}`);
}
run(process.execPath, [resolve(root, 'scripts/prepare-node-runtime.mjs')]);
if (mac) {
  run(process.execPath, [resolve(root, 'scripts/sync-pdf-assets.mjs')]);
  run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--release', '--bin', 'stashdock-preview', '--bin', 'stashdock-storage', '--bin', 'stashdock-browser']);
  for (const name of ['.codex-plugin', 'scripts', 'skills', 'assets']) await cp(resolve(root, 'plugins/stashdock', name), resolve(plugin, name), { recursive: true });
  await mkdir(resolve(plugin, 'server'), { recursive: true });
  for (const name of ['schema.sql', 'search-index.sql', 'preview-version.sql']) await copyFile(resolve(root, 'plugins/stashdock/server', name), resolve(plugin, 'server', name));
  const config = JSON.parse(await readFile(resolve(root, 'plugins/stashdock/.mcp.json'), 'utf8'));
  config.mcpServers.stashdock.command = './bin/darwin-arm64/node';
  config.mcpServers.stashdock.args = ['./scripts/mcp-server.mjs'];
  config.mcpServers.stashdock.cwd = '.';
  config.mcpServers.stashdock.tool_timeout_sec = 660;
  await writeFile(resolve(plugin, '.mcp.json'), JSON.stringify(config, null, 2) + '\n');
} else run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts/with-msvc.ps1'), 'preview-build']);
await mkdir(resolve(plugin, 'bin', platform), { recursive: true });
for (const name of ['stashdock-preview', 'stashdock-storage', 'stashdock-browser']) {
  const executable = name + (mac ? '' : '.exe');
  await copyFile(resolve(root, 'src-tauri/target/release', executable), resolve(plugin, 'bin', platform, executable));
}
const nodeName = mac ? 'node' : 'node.exe';
await copyFile(resolve(root, 'build-runtime/node', platform, nodeName), resolve(plugin, 'bin', platform, nodeName));
if (mac) {
  const renderer = resolve(plugin, 'bin', platform, 'StashDockRenderer.app');
  await cp(resolve(root, 'src-tauri/native-binaries/StashDockRenderer.app'), renderer, { recursive: true });
  const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
  for (const target of [renderer, ...['stashdock-preview', 'stashdock-storage', 'stashdock-browser'].map(name => resolve(plugin, 'bin', platform, name))]) {
    run('codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp=none']), target]);
    run('codesign', ['--verify', '--strict', '--deep', target]);
  }
}
await mkdir(resolve(plugin, 'assets'), { recursive: true });
await copyFile(resolve(root, 'assets/brand/icon.png'), resolve(plugin, 'assets/icon.png'));
const result = await viteBuild({ configFile: false, root: resolve(root, 'src/features/mcp-app'), plugins: [react()],
  build: { write: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } } },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const js = output.find(asset => asset.type === 'chunk' && asset.isEntry)?.code;
const css = output.filter(asset => asset.type === 'asset' && asset.fileName.endsWith('.css')).map(asset => asset.source).join('\n');
if (!js || output.some(asset => asset.type === 'asset' && !/\.(html|css)$/.test(asset.fileName))) throw new Error('MCP App must be self-contained.');
// Server and UI have no build-host branch. Keep the checked-in shared outputs
// current on either OS, then stage them beside that OS's native runtime.
await mkdir(resolve(sharedPlugin, 'web'), { recursive: true });
await writeFile(resolve(sharedPlugin, 'web/shelf.html'),
  `<!doctype html><html lang="en" data-accent="neutral"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>StashDock</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
const serverBuild = await esbuild({ entryPoints: [resolve(root, 'plugins/stashdock/server/create-server.mjs')], bundle: true, metafile: true,
  minify: true, keepNames: true, legalComments: 'eof',
  platform: 'node', format: 'esm', target: 'node22', outfile: resolve(sharedPlugin, 'dist/mcp-server.mjs'),
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
if (plugin !== sharedPlugin) {
  for (const folder of ['web', 'dist']) await cp(resolve(sharedPlugin, folder), resolve(plugin, folder), { recursive: true });
}
// A portable plugin does not ship node_modules, so include the licenses of the
// packages actually bundled in its server/UI, plus its embedded font faces.
const inputs = [...Object.keys(serverBuild.metafile.inputs), ...output.filter(asset => asset.type === 'chunk').flatMap(chunk => Object.keys(chunk.modules))];
const packages = new Set(['@fontsource-variable/inter', '@fontsource-variable/geist']);
for (const input of inputs) {
  const path = input.replaceAll('\\', '/');
  const marker = path.lastIndexOf('node_modules/');
  if (marker < 0) continue;
  const parts = path.slice(marker + 'node_modules/'.length).split('/');
  packages.add(parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/'));
}
const notices = resolve(plugin, 'notices');
// Notices describe exactly the dependencies in this build.
await rm(notices, { recursive: true, force: true });
await mkdir(notices, { recursive: true });
for (const name of ['LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md']) await copyFile(resolve(root, name), resolve(plugin, name));
await mkdir(resolve(plugin, 'licenses'), { recursive: true });
await copyFile(resolve(root, 'licenses/StashDock-legacy-MIT.txt'), resolve(plugin, 'licenses/StashDock-legacy-MIT.txt'));
await copyFile(resolve(root, 'build-runtime/node', platform, 'LICENSE'), resolve(notices, 'Node.js-LICENSE'));
const inventory = [];
inventory.push(`Node.js ${nodePin.version}: MIT and bundled third-party notices (Node.js-LICENSE)`);
for (const name of [...packages].sort()) {
  const folder = resolve(root, 'node_modules', name);
  const metadata = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  const files = (await readdir(folder)).filter(file => /^(?:licen[cs]e|copying|notice|ofl)(?:[.-]|$)/i.test(file));
  if (!files.length && name === '@cfworker/json-schema') {
    await copyFile(resolve(root, 'public/licenses/CFWorker-MIT.txt'), resolve(notices, 'CFWorker-MIT.txt'));
  } else if (!files.length && name === 'react-remove-scroll-bar') {
    // Upstream MIT LICENSE is omitted from this package's npm "files" list.
    await copyFile(resolve(root, 'public/licenses/react-remove-scroll-bar-MIT.txt'), resolve(notices, 'react-remove-scroll-bar-MIT.txt'));
  } else if (!files.length && name === 'boolbase') {
    // Upstream ISC LICENSE is omitted from the published 1.0.0 package.
    await copyFile(resolve(root, 'public/licenses/boolbase-ISC.txt'), resolve(notices, 'boolbase-ISC.txt'));
  } else if (!files.length) throw new Error(`Missing bundled dependency license: ${name}`);
  for (const file of files) await copyFile(resolve(folder, file), resolve(notices, `${name.replaceAll('/', '_')}--${file}`));
  inventory.push(`${name} ${metadata.version}: ${metadata.license || 'See license file'}`);
}
await copyFile(resolve(root, 'public/licenses/Arc-MIT.txt'), resolve(notices, 'Arc-MIT.txt'));
await copyFile(resolve(root, 'public/licenses/WebView2Com-MIT.txt'), resolve(notices, 'WebView2Com-MIT.txt'));
await copyFile(resolve(root, 'public/licenses/WindowsRs-MIT.txt'), resolve(notices, 'WindowsRs-MIT.txt'));
await copyFile(resolve(root, 'public/licenses/Brotli-MIT.txt'), resolve(notices, 'Brotli-MIT.txt'));
await copyFile(resolve(root, 'public/licenses/Brotli-BSD-3-Clause.txt'), resolve(notices, 'Brotli-BSD-3-Clause.txt'));
await copyFile(resolve(root, 'public/licenses/Flate2-MIT.txt'), resolve(notices, 'Flate2-MIT.txt'));
inventory.push('brotli 9.0.0: BSD-3-Clause AND MIT; flate2 1.1.10: MIT (native bounded response decoding)');
await copyFile(resolve(root, 'public/licenses/LobeIcons-LICENSE'), resolve(notices, 'LobeIcons-LICENSE'));
await copyFile(resolve(root, 'public/licenses/SimpleIcons-CC0.txt'), resolve(notices, 'SimpleIcons-CC0.txt'));
await copyFile(resolve(root, 'public/licenses/vscode-icons-MIT.txt'), resolve(notices, 'vscode-icons-MIT.txt'));
await copyFile(resolve(root, 'public/licenses/FlatColorIcons-LICENSE.md'), resolve(notices, 'FlatColorIcons-LICENSE.md'));
await copyFile(resolve(root, 'node_modules/pdfjs-dist/LICENSE'), resolve(notices, 'pdfjs-dist--LICENSE'));
inventory.push('pdfjs-dist 6.4.299: Apache-2.0 (embedded first-page PDF cover renderer)');
inventory.push('@iconify-icons/vscode-icons 2.0.16: MIT (generated local subset)');
inventory.push('@iconify-icons/flat-color-icons 2.0.0: MIT (generated local subset)');
await writeFile(resolve(notices, 'README.txt'), 'Bundled dependency notices. Original license files are included beside this inventory.\n\n' + inventory.join('\n'));
if (mac) await cp(resolve(root, 'public/licenses'), resolve(notices, 'native'), { recursive: true });
console.log('Plugin stage:', plugin);
console.log('Built self-contained MCP App HTML and portable stdio server.');
console.log('UI bytes:', (await readFile(resolve(plugin, 'web/shelf.html'))).length);
