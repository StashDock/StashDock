import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';
import { browserExtensionDetected } from './browser-presence.mjs';
import productLinks from '../../../src-tauri/product-links.json' with { type: 'json' };
import { githubRepositoryUrl } from './open-integration.mjs';
import { validBrowserExtensionId, pinnedBrowserExtensionId, nativeFirefoxOrigin, nativeSafariOrigin } from '../../../src/lib/browser-extension-identity.mjs';
const ids = ['chrome', 'edge', 'firefox', 'safari', 'codex', 'dsh', 'claude', 'desktop'];
function fileExists(path) { try { return isAbsolute(path) && statSync(path).isFile(); } catch { return false; } }
function packageAt(path) {
  try { return statSync(path).size <= 2_000_000 ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}
// Inspect only the profile that registered this package, never scan unrelated
// profiles. An uninstalled package or removed bundle must not stay Detected.
export function dshPluginDetected(manifest) {
  if (!fileExists(manifest) || packageAt(manifest)?.name !== 'stashdock-dsh' || !fileExists(join(dirname(manifest), 'index.mjs'))) return false;
  for (let directory = dirname(dirname(manifest)), depth = 0; depth < 12; depth++, directory = dirname(directory)) {
    const profile = packageAt(join(directory, 'package.json'))?.dsh?.profile;
    if (profile) return Array.isArray(profile.bundles) && profile.bundles.includes('stashdock-dsh');
    if (directory === dirname(directory)) break;
  }
  return false;
}
export function configuredCodexPlugin(text, manifest) {
  try {
    const config = parse(text);
    const marketplace = manifest.replaceAll('\\', '/').split('/plugins/cache/')[1]?.split('/stashdock/')[0];
    return Object.entries(config.plugins || {}).some(([key, plugin]) =>
      (marketplace ? key === `stashdock@${marketplace}` : key === 'stashdock' || key.startsWith('stashdock@')) &&
      plugin.enabled === true && plugin.mcp_servers?.stashdock?.enabled !== false);
  } catch { return false; }
}
export function codexPluginDetected(manifest, { home = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  try {
    const path = join(home, 'config.toml');
    return statSync(path).size <= 2_000_000 && configuredCodexPlugin(readFileSync(path, 'utf8'), manifest);
  } catch { return false; }
}
export function readIntegrations(read, { codexEnabled = codexPluginDetected, dshInstalled = dshPluginDetected, browserEnabled = browserExtensionDetected, platform = process.platform } = {}) {
  return { items: ids.map(id => {
    let record;
    try { record = JSON.parse(read(`installation_${id}_v1`) || 'null'); } catch { /* Corrupt optional presence is not an installation. */ }
    let detected = Boolean(record && typeof record.version === 'string' &&
      (record.path ? typeof record.path === 'string' && fileExists(record.path) && (id !== 'codex' || codexEnabled(record.path)) && (id !== 'dsh' || dshInstalled(record.path)) :
        browserEnabled(id, record.extensionId)));
    if (id === 'chrome' && !detected) {
      try {
        const other = JSON.parse(read('installation_edge_v1') || 'null');
        if (other?.extensionId === productLinks.browserExtensions.chrome.id && typeof other.version === 'string' && browserEnabled('edge', other.extensionId)) {
          record = other; detected = true;
        }
      } catch { /* Optional installation metadata may be absent. */ }
    }
    return { id, detected, ...(detected ? { version: record.version } : {}) };
  }), platform: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform, links: { ...productLinks.installationUrls, ...(platform === 'darwin' ? productLinks.macInstallationUrls : {}) }, githubUrl: githubRepositoryUrl() };
}
export function installationRecord(id, version, path, extensionId) {
  if (!ids.includes(id) || typeof version !== 'string' || !/^[\w.+-]{1,40}$/.test(version) ||
      (path !== undefined && (typeof path !== 'string' || path.length > 4096))) throw Error('Invalid StashDock installation.');
  if (extensionId !== undefined && !validBrowserExtensionId(id, extensionId)) throw Error('Invalid StashDock extension.');
  return { key: `installation_${id}_v1`, value: JSON.stringify({ version, ...(path ? { path } : {}), ...(extensionId ? { extensionId } : {}), seenAt: Date.now() }) };
}

export function browserInstallationRecord(read, browser, version, extensionId, origin, browserEnabled = browserExtensionDetected) {
  if (!['chrome', 'edge', 'firefox', 'safari'].includes(browser) || typeof origin !== 'string') throw Error('Invalid StashDock extension.');
  const validOrigin = browser === 'safari' ? nativeSafariOrigin(origin) : browser === 'firefox'
    ? nativeFirefoxOrigin(origin) || /^moz-extension:\/\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(origin)
    : origin === `chrome-extension://${extensionId}`;
  const nativeCaller = validBrowserExtensionId(browser, extensionId) &&
    (browser === 'firefox' && nativeFirefoxOrigin(origin) || browser === 'safari' && nativeSafariOrigin(origin));
  if (!validOrigin || !(nativeCaller || pinnedBrowserExtensionId(browser, extensionId) || browserEnabled(browser, extensionId))) throw Error('Invalid StashDock extension.');
  let previous;
  try { previous = JSON.parse(read(`installation_${browser}_v1`) || 'null'); } catch { /* Corrupt optional registration is replaced. */ }
  const origins = previous?.extensionId === extensionId && Array.isArray(previous.origins)
    ? previous.origins.filter(value => typeof value === 'string') : [];
  if (!origins.includes(origin)) origins.push(origin);
  const record = installationRecord(browser, version, undefined, extensionId);
  return { ...record, value: JSON.stringify({ ...JSON.parse(record.value), origins: origins.slice(-16) }) };
}

export function registeredBrowserOrigin(read, origin) {
  if (typeof origin !== 'string') return false;
  for (const browser of ['chrome', 'edge', 'firefox', 'safari']) {
    let record;
    try { record = JSON.parse(read(`installation_${browser}_v1`) || 'null'); } catch { continue; }
    if (!record || !validBrowserExtensionId(browser, record.extensionId) || !Array.isArray(record.origins) || !record.origins.includes(origin)) continue;
    if (browser === 'safari') return nativeSafariOrigin(origin);
    if (browser === 'firefox') return nativeFirefoxOrigin(origin) || /^moz-extension:\/\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(origin);
    return origin === `chrome-extension://${record.extensionId}`;
  }
  return false;
}
