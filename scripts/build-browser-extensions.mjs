// One source tree. Generate host-specific manifests, never fork capture/UI code.
import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import productLinks from '../src-tauri/product-links.json' with { type: 'json' };
import { build } from 'esbuild';
import { createHash, createPublicKey } from 'node:crypto';

export function chromiumIdentity(browser) {
  const identity = productLinks.browserExtensions[browser];
  if (!['chrome', 'edge'].includes(browser) || !identity?.publicKey) throw Error('Missing Chromium extension identity.');
  const bytes = Buffer.from(identity.publicKey, 'base64');
  createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  if (id !== identity.id) throw Error('The configured extension ID does not match its public key.');
  return identity;
}

export function browserManifest(base, browser) {
  if (!['chrome', 'edge', 'firefox', 'safari'].includes(browser)) throw Error('Unsupported browser build.');
  const manifest = structuredClone(base);
  if (browser === 'chrome' || browser === 'edge') manifest.key = chromiumIdentity(browser).publicKey;
  else delete manifest.key;
  if (browser === 'firefox') {
    delete manifest.minimum_chrome_version;
    delete manifest.side_panel;
    manifest.permissions = manifest.permissions.filter(value => value !== 'sidePanel');
    // Native Messaging is required by the shared save transport on every OS.
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.sidebar_action = { default_panel: 'sidepanel.html', default_title: manifest.name, default_icon: manifest.icons, open_at_install: false };
    manifest.browser_specific_settings = { gecko: { id: productLinks.browserExtensions.firefox.id, strict_min_version: productLinks.browserExtensions.firefox.minimumVersion,
      data_collection_permissions: { required: ['websiteContent', 'browsingActivity'] } } };
  }
  if (browser === 'safari') {
    delete manifest.minimum_chrome_version;
    delete manifest.incognito;
    delete manifest.side_panel;
    delete manifest.host_permissions;
    manifest.permissions = manifest.permissions.filter(value => value !== 'sidePanel');
    if (!manifest.permissions.includes('nativeMessaging')) manifest.permissions.push('nativeMessaging');
    manifest.background = { scripts: ['background.js'] };
    manifest.action.default_popup = 'sidepanel.html';
  }
  return manifest;
}

export async function buildExtensions(browsers = productLinks.publicBrowserExtensions) {
  const root = resolve(import.meta.dirname, '..'), source = join(root, 'extension');
  const destination = join(root, 'output', 'extensions');
  const base = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (base.key !== chromiumIdentity('chrome').publicKey) throw Error('The source Chrome manifest key has drifted from product-links.json.');
  const files = (await readdir(source)).filter(name => name !== 'manifest.json' && name !== 'README.md');
  for (const browser of browsers) {
    browserManifest(base, browser); // Validate before touching a generated path.
    const directory = join(destination, browser);
    if (!directory.startsWith(destination + sep)) throw Error('Invalid generated package directory.');
    // Only the three named generated directories, never source or user profiles.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    for (const name of ['LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(directory, name));
    await mkdir(join(directory, 'licenses'), { recursive: true });
    await cp(join(root, 'licenses/StashDock-legacy-MIT.txt'), join(directory, 'licenses/StashDock-legacy-MIT.txt'));
    for (const file of files) await cp(join(source, file), join(directory, file), { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(browserManifest(base, browser), null, 2) + '\n');
    if (browser === 'safari') {
      await build({ entryPoints: [join(source, 'background.js')], bundle: true, format: 'iife', target: 'es2022', outfile: join(directory, 'background.js') });
      const html = await readFile(join(directory, 'sidepanel.html'), 'utf8');
      await writeFile(join(directory, 'sidepanel.html'), html.replace('</head>', '<link rel="stylesheet" href="safari-popup.css"></head>'));
    }
    console.log(`${browser}: ${directory}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildExtensions(process.argv.includes('--internal') ? ['chrome', 'edge', 'firefox'] : undefined);
