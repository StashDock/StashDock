import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { locateLibrary, markLibraryReady } from '../plugins/stashdock/server/canonical-library.mjs';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { checkSetup, createSetupConnection } from '../extension/setup-client.js';
import { startCaptureBridge } from '../plugins/stashdock/server/capture-bridge.mjs';
import { once } from 'node:events';
import { readIntegrations, configuredCodexPlugin, codexPluginDetected, dshPluginDetected, installationRecord, browserInstallationRecord } from '../plugins/stashdock/server/integrations.mjs';
import { build } from 'esbuild';
import { zh } from '../src/features/settings/messages.mjs';
import { browserExtensionDetected, extensionEnabled } from '../plugins/stashdock/server/browser-presence.mjs';
import productLinks from '../src-tauri/product-links.json' with { type: 'json' };
import { pinnedBrowserExtensionId } from '../src/lib/browser-extension-identity.mjs';

test('pinned Chromium origins register without profile access but do not imply current installation presence', () => {
  for (const browser of ['chrome', 'edge']) {
    const id = productLinks.browserExtensions[browser].id;
    const origin = `chrome-extension://${id}`;
    const record = browserInstallationRecord(() => null, browser, '0.4.17', id, origin,
      () => assert.fail('Connection authorization must not open a private browser profile'));
    assert.deepEqual(JSON.parse(record.value).origins, [origin]);
    const status = readIntegrations(key => key === record.key ? record.value : null, { browserEnabled: () => false });
    assert.equal(status.items.find(item => item.id === browser).detected, false);
    assert.throws(() => browserInstallationRecord(() => null, browser, '0.4.17', id, 'https://example.org', () => true));
    assert.throws(() => browserInstallationRecord(() => null, browser, '0.4.17', id, 'chrome-extension://' + 'a'.repeat(32), () => true));
    const other = browser === 'chrome' ? 'edge' : 'chrome';
    if (!pinnedBrowserExtensionId(other, id)) assert.throws(() => browserInstallationRecord(() => null, other, '0.4.17', id, origin, () => false));
    for (const legacy of productLinks.browserExtensions[browser].legacyIds) {
      const legacyOrigin = `chrome-extension://${legacy}`;
      assert.equal(JSON.parse(browserInstallationRecord(() => null,browser,'0.4.19',legacy,legacyOrigin,()=>assert.fail('No profile access')).value).extensionId,legacy);
      if (!productLinks.browserExtensions[other].legacyIds.includes(legacy)) assert.throws(()=>browserInstallationRecord(()=>null,other,'0.4.19',legacy,legacyOrigin,()=>false));
    }
  }
});

test('browser registration requires the exact enabled StashDock extension', () => {
  const id = 'a'.repeat(32), origin = `chrome-extension://${id}`;
  assert.throws(
    () => browserInstallationRecord(() => undefined, 'chrome', '0.4.13', id, origin, () => false),
    /Invalid StashDock extension/,
  );
  assert.doesNotThrow(
    () => browserInstallationRecord(() => undefined, 'chrome', '0.4.13', id, origin, (browser, candidate) => browser === 'chrome' && candidate === id),
  );
});

test('one per-user anchor wins independent installation locations and fails closed if its database disappears', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-anchor-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b'), registry = join(root, 'registration', 'library-root-v1.json');
  const first = locateLibrary(a, registry);
  assert.equal(first.anchor, a); assert.equal(first.initialized, false);
  assert.equal(locateLibrary(b, registry).anchor, a);
  const raw = JSON.parse(readFileSync(registry)); raw.registry = join(root, 'must-not-write.json'); writeFileSync(registry, JSON.stringify(raw));
  assert.equal(locateLibrary(b, registry).registry, registry);
  mkdirSync(a); writeFileSync(join(a, 'stashdock.sqlite3'), 'original'); markLibraryReady(first);
  assert.equal(locateLibrary(b, registry).anchor, a);
  assert.equal(JSON.parse(readFileSync(registry)).initialized, true);
  rmSync(join(a, 'stashdock.sqlite3'));
  assert.throws(() => locateLibrary(b, registry), /unavailable/);
  writeFileSync(registry, '{broken'); assert.throws(() => locateLibrary(b, registry));
});
test('companion detection reads only StashDock registrations and does not confuse a missing file with installed', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-integration-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const library = createLocalLibrary({ dataDir: root });
  try {
    const path = join(root, 'own-plugin.json'); writeFileSync(path, '{}');
    library.registerInstallation('codex', '0.4.27', path); library.registerInstallation('chrome', '0.4.9');
    const states = library.integrations();
    // A leftover manifest alone is not an enabled installation.
    assert.equal(states.items.find(x => x.id === 'codex').detected, false);
    assert.equal(states.items.find(x => x.id === 'chrome').detected, false);
    assert.equal(states.items.find(x => x.id === 'desktop').detected, false);
    rmSync(path); assert.equal(library.integrations().items.find(x => x.id === 'codex').detected, false);
    assert.throws(() => library.registerInstallation('../arbitrary', '1'));
    assert.throws(() => library.registerInstallation('chrome', 'bad value'));
  } finally { library.close(); }
});
test('Codex detection re-reads enabled configuration and rejects uninstall/disable while the cached package remains', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-codex-presence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, 'plugins', 'cache', 'personal', 'stashdock', '1', '.codex-plugin', 'plugin.json');
  mkdirSync(join(manifest, '..'), { recursive: true }); writeFileSync(manifest, '{}');
  const config = join(root, 'config.toml');
  const enabled = '[plugins."stashdock@personal"]\nenabled = true';
  const detect = () => readIntegrations(key => key === 'installation_codex_v1' ? JSON.stringify({ version: '1', path: manifest }) : null, { codexEnabled: path => codexPluginDetected(path, { home: root }) }).items.find(item => item.id === 'codex').detected;
  assert.equal(detect(), false);
  writeFileSync(config, enabled); assert.equal(detect(), true);
  writeFileSync(config, '[plugins."stashdock@personal"]\nenabled = false'); assert.equal(detect(), false);
  writeFileSync(config, enabled + '\n[plugins."stashdock@personal".mcp_servers.stashdock]\nenabled=false'); assert.equal(detect(), false);
  writeFileSync(config, enabled); assert.equal(detect(), true);
  writeFileSync(config, ''); assert.equal(detect(), false);
  assert.ok(readFileSync(manifest));
  assert.equal(configuredCodexPlugin('[plugins."stashdock@other"]\nenabled=true', manifest), false);
  assert.equal(configuredCodexPlugin('[broken', manifest), false);
});
test('extension discovers either local provider, accepts legacy health, and reports missing services honestly', async () => {
  const calls = [];
  const request = async url => { calls.push(url); return url.includes('17863') ? { ok: true, json: async () => ({ connected: true, owner: 'desktop', integrations: { items: [] } }) } : { ok: false }; };
  assert.equal((await checkSetup({ fetcher: request })).owner, 'desktop');
  assert.ok(calls.every(url => /^http:\/\/127\.0\.0\.1:(17863|17864)\/v1\/(setup|health)$/.test(url)));
  assert.equal((await checkSetup({ fetcher: async () => { throw Error('offline'); } })).connected, false);
  const legacy = await checkSetup({ fetcher: async url => ({ ok: url.endsWith('health'), status: url.endsWith('health') ? 200 : 404, json: async () => ({ status: 'ready', app: 'StashDock library' }) }) });
  assert.equal(legacy.connected, true);
});

test('a legacy provider cannot hide a setup-capable provider, and parallel checks share one request', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('17863')) return { ok: true, json: async () => ({ connected: true, owner: 'desktop', integrations: { items: [{ id: 'chrome', detected: true }] } }) };
    return { ok: url.endsWith('health'), status: url.endsWith('health') ? 200 : 404, json: async () => ({ status: 'ready', app: 'StashDock library' }) };
  };
  const setup = createSetupConnection({ fetcher });
  const first = setup(), second = setup(); assert.equal(first, second);
  assert.equal((await first).owner, 'desktop');
  assert.equal(calls.filter(url => url.includes('17863')).length, 1);
  await setup(); assert.equal(calls.filter(url => url.includes('17863')).length, 2);
});

test('a healthy provider cannot hide rejected registration or a broken setup response', async () => {
  for (const status of [400, 403, 429, 500, 200]) {
    const calls = [];
    const result = await checkSetup({ fetcher: async url => {
      calls.push(url);
      if (url.endsWith('/health')) return Response.json({ status: 'ready', app: 'StashDock library' });
      return Response.json({ error: 'Extension verification failed.' }, { status });
    } });
    assert.equal(result.connected, false);
    assert.equal(result.error, 'Extension verification failed.');
    assert.equal(calls.length, 2, 'one bounded setup request per provider, without health fallback');
  }
});

test('registration failure in one provider does not hide successful registration in the other', async () => {
  const result = await checkSetup({ fetcher: async url => url.includes('17864')
    ? Response.json({ error: 'Extension verification failed.' }, { status: 400 })
    : Response.json({ connected: true, owner: 'desktop', integrations: { items: [] } }) });
  assert.equal(result.connected, true);
  assert.equal(result.owner, 'desktop');
});

test('an old browser handshake alone never proves an extension is still enabled', () => {
  const status = readIntegrations(key => key === 'installation_chrome_v1' ? JSON.stringify({ version: '0.4.10', seenAt: Date.now() - 60 * 86400000 }) : null);
  assert.equal(status.items.find(value => value.id === 'chrome').detected, false);
});
test('browser detection follows only the registered extension, including disable and removal', t => {
  const root=mkdtempSync(join(tmpdir(),'stashdock-browser-presence-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'Default')); const id='a'.repeat(32), path=join(root,'Default','Secure Preferences');
  const record={extensions:{settings:{[id]:{manifest:{name:'StashDock Companion'},state:1,disable_reasons:[]}}}};
  const detect=()=>browserExtensionDetected('chrome',id,{root});
  writeFileSync(path,JSON.stringify(record));assert.equal(detect(),true);
  record.extensions.settings[id].disable_reasons=[1];writeFileSync(path,JSON.stringify(record));assert.equal(detect(),false);
  record.extensions.settings[id].disable_reasons=[];writeFileSync(path,JSON.stringify(record));assert.equal(detect(),true);
  delete record.extensions.settings[id].state;delete record.extensions.settings[id].disable_reasons;
  writeFileSync(path,JSON.stringify(record));assert.equal(detect(),true);
  const unpacked=join(root,'unpacked');mkdirSync(unpacked);writeFileSync(join(unpacked,'manifest.json'),JSON.stringify({name:'StashDock Companion'}));
  delete record.extensions.settings[id].manifest;record.extensions.settings[id].path=unpacked;
  writeFileSync(path,JSON.stringify(record));assert.equal(detect(),true);
  delete record.extensions.settings[id];writeFileSync(path,JSON.stringify(record));assert.equal(detect(),false);
  writeFileSync(join(root,'Default','Preferences'),JSON.stringify({extensions:{settings:{[id]:{manifest:{name:'StashDock Companion'},state:1}}}}));
  assert.equal(detect(),false,'Secure Preferences removal must beat an old legacy entry');
  assert.equal(extensionEnabled({extensions:{settings:{[id]:{manifest:{name:'Other app'},state:1}}}},id),false);
  assert.equal(browserExtensionDetected('chrome','../../other',{root}),false);
});
test('host-specific sections keep browsers separate from AI plugins and do not advertise competitors inside Codex', () => {
  const source = readFileSync('src/features/settings/IntegrationSections.tsx', 'utf8');
  assert.match(source, /: \[\{ title: 'Browser extensions', ids: browsers \}, \{ title: 'Desktop app'/);
  assert.doesNotMatch(source, /'browser'/);
  assert.match(source, /!entry.ready && info && <span[^>]*>\{t\('Coming soon'\)\}/);
  assert.doesNotMatch(readFileSync('src/features/mcp-app/McpSettingsView.tsx', 'utf8'), /Shared with the desktop app/);
  const worker = readFileSync('extension/background.js', 'utf8');
  assert.doesNotMatch(worker, /setup\.html|open-integration/);
  assert.match(worker, /return library.save\(item/);
  assert.match(readFileSync('extension/library-client.js','utf8'), /Install the latest StashDock Desktop or AI plugin, then retry/);
});
test('settings explanations reuse shared tooltips with a normal pointer and detected integrations open usage guides', () => {
  const help = readFileSync('src/features/settings/SettingHelp.tsx', 'utf8');
  assert.match(help, /<button type="button"/);
  assert.match(help, /aria-label=\{label\} data-tooltip=\{children\}/);
  assert.doesNotMatch(help, /Popover|onClick|title=/);
  const integrations = readFileSync('src/features/settings/IntegrationSections.tsx', 'utf8');
  assert.match(integrations, /<SettingHelp label=\{t\('About \{section\}'/);
  assert.match(integrations, /state\?\.detected \? 'View guide' : 'Set up'/);
  assert.match(integrations, /data-detected>\{t\('Detected'\)\}/);
  assert.match(integrations, /kind: entry.ready && state\?\.detected \? 'usage' : 'setup'/);
  assert.match(readFileSync('src/features/settings/IntegrationGuide.tsx','utf8'), /steps\.map/);
  assert.match(integrations, /className=\{styles.actions\}>\{entry.ready && state\?\.detected/);
  assert.doesNotMatch(integrations, /Configured|In use|styles\.purpose|disabled=\{disabled \|\| state\?\.detected\}/);
  const css = readFileSync('src/features/settings/SettingsView.module.css', 'utf8');
  assert.match(css, /\.helpButton \{[^}]*cursor: pointer/);
  assert.doesNotMatch(css, /cursor: help/);
  assert.match(readFileSync('src/features/settings/IntegrationSections.module.css', 'utf8'), /list-style-type: decimal/);
});

test('approved purpose copy and complete localized guides cover every implemented integration', async () => {
  const result = await build({ entryPoints: ['src/features/settings/integrations.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { integrationCatalog, integrationGuides } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.equal(integrationCatalog.chrome.purpose, 'Save pages while you browse.');
  assert.equal(integrationCatalog.codex.purpose, 'Browse your library and use references as context in conversations.');
  assert.equal(integrationGuides.codex.description, integrationCatalog.codex.purpose);
  assert.equal(integrationGuides.desktop.description, integrationCatalog.codex.purpose);
  assert.equal(integrationCatalog.desktop.purpose, 'Browse and manage your references visually in a standalone desktop app. Bring them into any AI app.');
  for (const [id, entry] of Object.entries(integrationCatalog)) {
    assert.ok(zh[entry.purpose], `Missing purpose translation: ${id}`);
    if (!entry.ready) continue;
    const guide = integrationGuides[id];
    assert.equal(guide.steps.length, 3);
    for (const text of [guide.title, guide.description, ...guide.steps]) assert.ok(zh[text], `Missing guide translation: ${text}`);
    assert.ok(!guide.steps.some(step => /^Install/.test(step)), `Usage guide is an installation guide: ${id}`);
  }
});

test('DSH sits between ChatGPT and Claude with an actionable localized setup and usage guide', async () => {
  const result = await build({ entryPoints: ['src/features/settings/integrations.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { agents, integrationCatalog, integrationGuides, aiSetupSteps, applicationWebsite } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.deepEqual(agents, ['codex', 'dsh', 'claude']);
  assert.equal(integrationCatalog.dsh.name, 'DeepSeek Harness');
  assert.equal(integrationCatalog.dsh.ready, true);
  assert.equal(integrationCatalog.claude.ready, false);
  assert.equal(applicationWebsite('dsh'), 'https://deepseek.com/harness');
  assert.equal(integrationGuides.dsh.description, integrationGuides.codex.description);
  assert.ok(aiSetupSteps.some(step => step.includes('ask it to install the StashDock plugin for {name}')));
  assert.ok(aiSetupSteps.some(step => step.includes('fully quit and reopen')));
  for (const text of aiSetupSteps) assert.ok(zh[text], text);
});

test('DSH installation presence is independent and rereads package removal and profile bundle changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-dsh-presence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'node_modules', 'stashdock-dsh');
  mkdirSync(directory, { recursive: true });
  const manifest = join(directory, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: 'stashdock-dsh', version: '1.1.0' }));
  writeFileSync(join(directory, 'index.mjs'), 'export {};');
  const profile = join(root, 'package.json');
  writeFileSync(profile, JSON.stringify({ dsh: { profile: { bundles: ['stashdock-dsh'] } } }));
  const record = installationRecord('dsh', '1.1.0', manifest);
  const read = () => readIntegrations(key => key === record.key ? record.value : null);
  assert.equal(dshPluginDetected(manifest), true);
  assert.equal(read().items.find(item => item.id === 'dsh').detected, true);
  assert.equal(read().items.find(item => item.id === 'codex').detected, false);
  writeFileSync(profile, JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  assert.equal(dshPluginDetected(manifest), false);
  writeFileSync(profile, JSON.stringify({ dsh: { profile: { bundles: ['stashdock-dsh'] } } }));
  rmSync(join(directory, 'index.mjs'));
  assert.equal(read().items.find(item => item.id === 'dsh').detected, false);
});

test('AI setup copies the repository and asks the named host to install even when a website guide exists', async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { IntegrationGuide } from './src/features/settings/IntegrationGuide';
    export const pages = ['codex', 'dsh'].map(id => renderToStaticMarkup(React.createElement(IntegrationGuide, {
      id, kind:'setup', info:{items:[], links:{codex:'https://stashdock.app/guide#install-plugin',dsh:'https://stashdock.app/guide#install-dsh'}, githubUrl:'https://github.com/StashDock/StashDock'}, openLink:async()=>{}
    })));
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'esm', platform:'node', packages:'external', jsx:'automatic', loader:{'.module.css':'empty','.css':'empty','.svg':'text','.png':'dataurl'} });
  const path = join(process.cwd(), 'node_modules', `.stashdock-ai-guide-${process.pid}.mjs`);
  try {
    writeFileSync(path, result.outputFiles[0].text);
    const { pages } = await import(pathToFileURL(path).href);
    for (const [index, html] of pages.entries()) {
      const name = index === 0 ? 'ChatGPT' : 'DeepSeek Harness';
      assert.ok(html.includes(`Paste it into ${name} and ask it to install the StashDock plugin for ${name}.`));
      assert.ok(html.includes(`After installation, fully quit and reopen ${name}.`));
      assert.match(html, /aria-label="Copy GitHub link"/);
      assert.equal((html.match(/<li>/g) || []).length, 4);
      assert.doesNotMatch(html, /Open installation page|In a terminal|package\.tgz/);
    }
  } finally { rmSync(path, {force:true}); }
});

test('an actual extension setup handshake registers against the provider library without accepting website callers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-setup-bridge-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = createLocalLibrary({ dataDir: root, browserEnabled: () => true }), server = startCaptureBridge(library, 0);
  try {
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/v1/setup`;
    const headers = { 'content-type': 'application/json', 'x-stashdock-client': 'chrome-extension-v1', origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ browser: 'chrome', version: '0.4.9' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).connected, true);
    // Registration identifies this extension, but the synthetic ID is not
    // installed in a real browser and must not be called Detected.
    assert.equal(library.integrations().items.find(v => v.id === 'chrome').detected, false);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ browser:'chrome',version:'1',extensionId:'b'.repeat(32) }) })).status,400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ browser: 'desktop', version: '1' }) })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); library.close(); }
});


test('Safari is actionable only on Mac, with a localized usage guide and bundled setup', async () => {
  const result = await build({ entryPoints: ['src/features/settings/integrations.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { integrationReady, integrationGuides, safariSetupSteps } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.equal(integrationReady('safari', null), false);
  for (const platform of ['windows', 'linux', undefined]) assert.equal(integrationReady('safari', { items: [], platform }), false);
  assert.equal(integrationReady('safari', { items: [], platform: 'macos' }), true);
  assert.equal(integrationReady('chrome', { items: [], platform: 'windows' }), true);
  assert.equal(integrationReady('claude', { items: [], platform: 'macos' }), false);
  for (const text of [integrationGuides.safari.title, ...safariSetupSteps]) assert.ok(zh[text], text);
});

test('Safari setup describes the bundled extension without a redundant install or Copy action', async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { IntegrationGuide } from './src/features/settings/IntegrationGuide';
    export const html = renderToStaticMarkup(React.createElement(IntegrationGuide, {
      id: 'safari', kind: 'setup', info: {items:[], platform:'macos', githubUrl:'https://github.com/example/repo'}, openLink: async()=>{}
    }));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', loader: { '.module.css': 'empty', '.css': 'empty', '.svg': 'text', '.png': 'dataurl' } });
  const path = join(process.cwd(), 'node_modules', `.stashdock-guide-test-${process.pid}.mjs`);
  try {
    writeFileSync(path, result.outputFiles[0].text);
    const { html } = await import(pathToFileURL(path).href + '?safari');
    assert.match(html, /included with StashDock Desktop/);
    assert.match(html, /Settings → Extensions/);
    assert.match(html, /Open Safari/);
    assert.doesNotMatch(html, /Copy GitHub|Open installation page|Get the browser extension/);
    assert.equal((html.match(/<li>/g) || []).length, 3);
  } finally { rmSync(path, {force:true}); }
});


test('both platforms send setup to the website guide, never to Windows-only instructions', () => {
  const mac = readIntegrations(() => null, { platform: 'darwin' });
  const win = readIntegrations(() => null, { platform: 'win32' });
  assert.equal(mac.platform, 'macos');
  assert.equal(win.platform, 'windows');
  for (const links of [mac.links, win.links]) {
    assert.equal(links.chrome, `https://chromewebstore.google.com/detail/${productLinks.browserExtensions.chrome.id}`);
    assert.equal(links.codex, 'https://stashdock.app/guide#install-plugin');
    assert.equal(links.desktop, 'https://stashdock.app/guide#install-desktop');
    assert.doesNotMatch(JSON.stringify(links), /windows-plugin-install|releases\/latest/);
  }
});


test('a Safari registration cannot be detected from an unrelated Chromium profile', t => {
  const root = mkdtempSync(join(tmpdir(), 'stashdock-safari-presence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Default'));
  const id = 'app.stashdock.desktop.SafariExtension';
  writeFileSync(join(root, 'Default', 'Secure Preferences'), JSON.stringify({extensions:{settings:{[id]:{manifest:{name:'StashDock Companion'},state:1}}}}));
  assert.equal(browserExtensionDetected('safari', id, {root}), false);
});


test('both settings hosts present only the published Chrome extension', async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { IntegrationSections } from './src/features/settings/IntegrationSections';
    export const html = ['desktop','codex'].map(host => renderToStaticMarkup(React.createElement(IntegrationSections, {
      host, load:async()=>({items:[], platform:'macos'}), openLink:async()=>{}
    })));
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'esm', platform:'node', packages:'external', jsx:'automatic', loader:{'.module.css':'empty','.css':'empty','.svg':'text','.png':'dataurl'} });
  const path = join(process.cwd(),'node_modules',`.stashdock-loading-test-${process.pid}.mjs`);
  try {
    writeFileSync(path,result.outputFiles[0].text);
    const {html} = await import(pathToFileURL(path).href+'?initial');
    for (const host of html) {
      assert.match(host,/data-integration-row="chrome"/);
      assert.doesNotMatch(host,/data-integration-row="(?:edge|firefox|safari)"/);
      assert.doesNotMatch(host,/Coming soon/);
      assert.match(host,/Check installation status/);
    }
  } finally {rmSync(path,{force:true});}
});

test('the Chrome extension can register and be detected in Edge without profile access for authorization', () => {
  const id = productLinks.browserExtensions.chrome.id;
  const record = browserInstallationRecord(() => null, 'edge', '0.4.26', id, `chrome-extension://${id}`, () => assert.fail('Pinned Chrome extension must not scan profiles for authorization'));
  const read = key => key === record.key ? record.value : null;
  const enabled = browser => browser === 'edge';
  assert.equal(readIntegrations(read, {browserEnabled: enabled}).items.find(item => item.id === 'chrome').detected, true);
  assert.equal(readIntegrations(read, {browserEnabled: () => false}).items.find(item => item.id === 'chrome').detected, false);
});
