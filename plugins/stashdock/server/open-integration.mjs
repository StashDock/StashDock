import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreviewHelper } from './preview-helper.mjs';
import productLinks from '../../../src-tauri/product-links.json' with { type: 'json' };

const exec = promisify(execFile);
export function githubRepositoryUrl(repository = productLinks.githubRepository) {
  return typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository) && repository.split('/').every(part => !['.', '..'].includes(part)) ? `https://github.com/${repository}` : null;
}
async function registry(key, value) {
  try { return (await exec('reg.exe', ['query', key, ...(value === undefined ? [] : value === '' ? ['/ve'] : ['/v', value])], { windowsHide: true, timeout: 1500, maxBuffer: 16384 })).stdout; }
  catch { return null; }
}
function executable(path, name, file = value => statSync(value).isFile()) {
  try { return typeof path === 'string' && win32.isAbsolute(path) && win32.basename(path).toLowerCase() === name && file(path) ? path : null; } catch { return null; }
}
export async function resolveMacIntegration(id, desktopPath) {
  const helper = resolve(fileURLToPath(new URL('..', import.meta.url)), 'bin', `${process.platform}-${process.arch}`, 'stashdock-preview');
  const result = await runPreviewHelper(helper, { integrationOperation: 'resolve', id, ...(desktopPath ? { desktopPath } : {}) }, undefined, { timeout: 20_000, maxOutput: 65536 });
  if (result.error) throw Error(result.error);
  if (result.application !== null && (typeof result.application !== 'string' || !result.application.startsWith('/') || !result.application.endsWith('.app'))) throw Error('The application could not be located.');
  return { application: result.application, safariStatusProbe: result.safariStatusProbe === true };
}
export async function resolveMacApplication(id, desktopPath) {
  return (await resolveMacIntegration(id, desktopPath)).application;
}
export async function integrationDestination(id, { platform = process.platform, readRegistry = registry, desktopPath, file, macApplication = resolveMacApplication } = {}) {
  if (!Object.hasOwn(productLinks.applications, id)) throw Error('Choose a supported StashDock app.');
  const target = productLinks.applications[id];
  if (platform === 'darwin') {
    const application = await macApplication(id, desktopPath);
    if (application) return { target: application, fallback: null };
  }
  if (platform === 'win32') {
    if (id === 'desktop') {
      const path = executable(desktopPath, 'stashdock.exe', file);
      if (path) return { target: path, fallback: target.website };
    }
    for (const scheme of target.protocols || []) {
      if (await readRegistry(`HKCR\\${scheme}\\shell\\open\\command`) !== null) return { target: target.launchUrl || `${scheme}://`, fallback: target.website };
    }
    if (target.executable) for (const root of ['HKCU', 'HKLM']) {
      const raw = await readRegistry(`${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${target.executable}`, '');
      const path = raw?.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (match, key) => process.env[key] || match);
      const valid = executable(path, target.executable, file);
      if (valid) return { target: valid, fallback: target.website };
    }
  }
  const fallback = target.website || (id === 'desktop' ? productLinks.installationUrls.desktop || githubRepositoryUrl() : null);
  if (!fallback) throw Error('The StashDock Desktop download link is not available yet.');
  return { target: fallback, fallback: null };
}
export async function openIntegration(id, { desktopPath, platform = process.platform, launch = spawn, ...options } = {}) {
  const destination = await integrationDestination(id, { desktopPath, platform, ...options });
  if (platform === 'darwin') {
    try { await exec('/usr/bin/open', [destination.target], { timeout: 15_000, maxBuffer: 65536 }); }
    catch { throw Error('The app could not be opened. Try again.'); }
    return { opened: true };
  }
  const open = target => new Promise((resolve, reject) => {
    const [command, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]] : platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    const child = launch(command, args, { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  try { await open(destination.target); } catch { if (destination.fallback) await open(destination.fallback); else throw Error('The app could not be opened. Try again.'); }
  return { opened: true };
}
