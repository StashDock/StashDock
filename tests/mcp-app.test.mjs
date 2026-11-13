import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '@modelcontextprotocol/ext-apps';
import ts from 'typescript';
import { createServer, SHELF_URI } from '../plugins/stashdock/server/create-server.mjs';
import { prepareAttachment, visualSummary, faviconOrigins, publicImageUrl, search } from '../plugins/stashdock/server/library.mjs';
import { buildContext } from '../src/lib/context-format.mjs';

const item = { id: 'a', title: 'Saved page', kind: 'web', source: 'fixture.test', url: 'https://fixture.test/a',
  content: 'Full captured body. '.repeat(2000), excerpt: 'Short excerpt', tags: ['Design'], createdAt: '2026-10-09',
  preview: 'data:image/png;base64,aGVsbG8=', origin: { platform: 'browser', faviconUrl: 'https://fixture.test/favicon.ico' } };
const htmlUrl = new URL('../plugins/stashdock/web/shelf.html', import.meta.url);
const source = await readFile(new URL('../src/features/mcp-app/draft.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replace("'@openai/mcp-extensions/app'", JSON.stringify(new URL('../node_modules/@openai/mcp-extensions/dist/app/index.js', import.meta.url).href))
  .replace("'./dsh-draft.mjs'", JSON.stringify(new URL('../src/features/mcp-app/dsh-draft.mjs', import.meta.url).href));
const draft = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('DSH Add passes final Markdown with an explicit draft-only intent', async () => {
  const key = 'stashdock/dsh-draft';
  const attachment = prepareAttachment([item], ['a']);
  const host = {
    getHostCapabilities: () => ({ message: { text: {} }, experimental: { [key]: {} } }),
    sendMessage: async params => {
      assert.deepEqual(params, {
        role: 'user',
        content: [{ type: 'text', text: attachment.content[0].resource.text }],
        _meta: { [key]: { send: false, title: attachment.title } },
      });
      return {};
    },
  };
  await draft.addAttachmentToDraft(host, attachment);
  await assert.rejects(draft.addAttachmentToDraft({ ...host, sendMessage: async () => ({ isError: true }) }, attachment));
});

test('snapshot matches the final editor context, order and provenance; top-level content is only an embedded resource', () => {
  const result = prepareAttachment([item, { ...item, id: 'b', title: 'Second', content: 'Other' }], ['b', 'a', 'b']);
  assert.deepEqual(result.ids, ['b', 'a']);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'resource');
  assert.equal(result.content[0].resource.mimeType, 'text/markdown');
  assert.equal(result.content[0].resource.text, buildContext([{ ...item, id: 'b', title: 'Second', content: 'Other' }, item]));
  assert.ok(result.content[0].resource.text.indexOf('## Second') < result.content[0].resource.text.indexOf('## Saved page'));
  assert.match(result.content[0].resource.text, /URL: https:\/\/fixture.test\/a/);
  assert.match(result.content[0].resource.uri, /^stashdock:\/\/snapshot\/[a-f0-9]{64}\//);
  assert.deepEqual(draft.parseAttachment(result), result);
  assert.throws(() => prepareAttachment([item], ['missing']), /no longer/);
  assert.throws(() => prepareAttachment([item], []), /Select/);
  assert.throws(() => prepareAttachment([{ ...item, contextOverride: 'x'.repeat(2_000_001) }], ['a']), /too large/);
});

test('App metadata embeds previews and allows favicon images only from exact declared public origins', () => {
  const value = visualSummary(item);
  assert.equal(value.content, undefined);
  assert.equal(value.preview, item.preview);
  assert.equal(value.origin.faviconUrl, undefined);
  const origins = faviconOrigins([item]);
  assert.deepEqual(origins, ['https://fixture.test']);
  assert.equal(visualSummary(item, origins).origin.faviconUrl, item.origin.faviconUrl);
  for (const invalid of ['file:///secret.png', 'http://127.0.0.1/favicon.ico', 'http://192.168.1.1/favicon.ico', 'http://localhost/a', 'https://user:password@site.test/a', 'javascript:alert(1)', 'http://device.local/a']) assert.equal(publicImageUrl(invalid), undefined);
  assert.equal(visualSummary({ ...item, origin: { faviconUrl: 'https://other.test/a.png' } }, origins).origin.faviconUrl, undefined);
  assert.equal(visualSummary({ ...item, preview: 'file:///secret.png' }).preview, undefined);
  assert.equal(visualSummary({ ...item, preview: 'https://external.test/tracking.png' }).preview, undefined);
});

test('MCP collection filters match the browser shelf and paginate after filtering', () => {
  const rows = [
    { ...item, id: 'recent', createdAt: new Date().toISOString(), favorite: true },
    { ...item, id: 'old', createdAt: '2000-01-01', kind: 'repo' },
    { ...item, id: 'file', createdAt: '2000-01-01', kind: 'pdf' },
    { ...item, id: 'note', createdAt: '2000-01-01', kind: 'note' },
  ];
  assert.deepEqual(search(rows, { collection: 'recent' }).items.map(row => row.id), ['recent']);
  assert.deepEqual(search(rows, { collection: 'web' }).items.map(row => row.id), ['recent', 'old']);
  assert.deepEqual(search(rows, { collection: 'files' }).items.map(row => row.id), ['file']);
  assert.deepEqual(search(rows, { collection: 'favorites' }).items.map(row => row.id), ['recent']);
  assert.equal(search(rows, { collection: 'web', limit: 1 }).hasMore, true);
  assert.deepEqual(search(rows, { collection: 'web', limit: 1, offset: 1 }).items.map(row => row.id), ['old']);
});

test('MCP and browser share shelf presentation; draft actions stay compact with semantic success', async () => {
  const shelf = await readFile(new URL('../src/features/mcp-app/McpShelf.tsx', import.meta.url), 'utf8');
  for (const source of [shelf]) {
    assert.match(source, /shelfFilters/);
  }
  assert.match(shelf, /context\.bar/);
  assert.match(shelf, /<ReferenceCardView/);
  assert.match(await readFile(new URL('../src/components/StashCard.tsx', import.meta.url), 'utf8'), /<SiteIdentity item=\{item\}/);
  assert.match(shelf, /action\.success/);
  assert.match(shelf, /setAcknowledged\(\[\]\)/);
  assert.doesNotMatch(shelf, /confirmedAdds/);
  assert.match(shelf, /selected\.length > 0 && <motion\.footer hidden=\{settingsOpen\}/);
  // A successful draft add retains selection. Confirmed deletion may remove it.
  assert.doesNotMatch(shelf.slice(shelf.indexOf('const add = async'), shelf.indexOf('return <main')), /setSelected/);
  const manifest = JSON.parse(await readFile(new URL('../plugins/stashdock/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.interface.composerIcon, './assets/icon.png');
  assert.equal(manifest.interface.logo, './assets/icon.png');
  assert.deepEqual(await readFile(new URL('../plugins/stashdock/assets/icon.png', import.meta.url)), await readFile(new URL('../assets/brand/icon.png', import.meta.url)));
});

test('MCP panel fills the host viewport without an inline resize feedback loop or empty bottom reserve', async () => {
  const css = await readFile(new URL('../src/features/mcp-app/McpShelf.module.css', import.meta.url), 'utf8');
  const shelf = await readFile(new URL('../src/features/mcp-app/McpShelf.tsx', import.meta.url), 'utf8');
  assert.match(css, /height: 100dvh/);
  assert.doesNotMatch(css, /(?:height|min-height|max-height):\s*720px|min-height: 320px/);
  assert.match(css, /\.content \{ padding: var\(--space-3\); \}/);
  assert.match(shelf, /selected\.length \? styles\.contentWithSelection/);
  assert.match(shelf, /availableDisplayModes: \['fullscreen'\]/);
  assert.match(shelf, /autoResize: false/);
  assert.match(shelf, /host\.availableDisplayModes\?\.includes\('fullscreen'\)/);
  assert.match(shelf, /app\.requestDisplayMode\(\{ mode: 'fullscreen' \}\)/);
});

test('MCP SDK registers App resource/entrypoint and app-only tools without remount templates', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stashdock-mcp-test-entry-'));
  const fixture = createLocalLibrary({ dataDir });
  const savedItem = fixture.importItems([item]).items[0]; fixture.close();
  const server = createServer({ htmlUrl, dataDir });
  const client = new Client({ name: 'StashDock test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await client.connect(right);
    const list = await client.listTools();
    const open = list.tools.find(tool => tool.name === 'open_stashdock');
    assert.equal(open._meta.ui.resourceUri, SHELF_URI);
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.ok(!list.tools.some(tool => tool.name === 'get_stashdock_dock_url'));
    assert.ok(list.tools.some(tool => tool.name === 'get_stashdock_file' && tool.annotations.readOnlyHint));
    assert.equal(open._meta['openai/ui'].preferredModelDisplayMode, 'fullscreen');
    for (const name of ['list_stashdock_shelf', 'prepare_stashdock_attachment']) {
      const tool = list.tools.find(tool => tool.name === name);
      assert.deepEqual(tool._meta.ui.visibility, ['app']);
      assert.equal(tool._meta.ui.resourceUri, undefined);
      assert.equal(tool.annotations.readOnlyHint, true);
    }
    const ui = await client.readResource({ uri: SHELF_URI });
    assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(ui.contents[0]._meta['openai/ui'], { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] });
    assert.match(ui.contents[0].text, /<script type="module">/);
    assert.deepEqual(ui.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: ['https://fixture.test'] });
    assert.equal(client.getServerVersion().icons[0].mimeType, 'image/png');
    const shelf = await client.callTool({ name: 'list_stashdock_shelf', arguments: {} });
    assert.equal(shelf._meta.items[0].preview, item.preview);
    assert.equal(shelf._meta.items[0].content, undefined);
    assert.equal(shelf._meta.items[0].origin.faviconUrl, item.origin.faviconUrl);
    const prepared = await client.callTool({ name: 'prepare_stashdock_attachment', arguments: { ids: [savedItem.id] } });
    assert.equal(prepared._meta.attachment.content[0].resource.text, buildContext([savedItem]));
    assert.equal(prepared.structuredContent.content, undefined);
    const missing = await client.callTool({ name: 'prepare_stashdock_attachment', arguments: { ids: ['missing'] } });
    assert.equal(missing.isError, true);
  } finally { await client.close(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

for (const messageCapability of [{}, { draft: {} }]) test(`real App SDK transport preserves send:false with ${JSON.stringify(messageCapability)} and exact context in a titled inline attachment`, async () => {
  const app = new App({ name: 'test', version: '1' }, {}, { autoResize: false });
  const [view, host] = InMemoryTransport.createLinkedPair();
  const received = [];
  host.onmessage = async request => {
    if (request.id === undefined) return;
    if (request.method === 'ui/initialize') {
      await host.send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion,
        hostInfo: { name: 'test host', version: '1' }, hostContext: {},
        hostCapabilities: { message: { text: {}, resource: {} }, experimental: { 'openai/message': messageCapability } } } });
    } else { received.push(request); await host.send({ jsonrpc: '2.0', id: request.id, result: {} }); }
  };
  await host.start();
  try {
    await app.connect(view);
    await draft.addAttachmentToDraft(app, prepareAttachment([item], ['a']));
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'ui/message');
    assert.deepEqual(received[0].params._meta['openai/message'], { target: 'active', send: false });
    assert.equal(received[0].params.content[0].type, 'text');
    assert.equal(received[0].params.content[0].text, buildContext([item]));
    assert.equal(received[0].params.content[0]._meta['openai/title'], item.title);
    await draft.addAttachmentToDraft(app, prepareAttachment([{ ...item, title: 'A'.repeat(100) }], ['a']));
    assert.equal(received[1].params.content[0]._meta['openai/title'], 'A'.repeat(47) + '…');
    await draft.addAttachmentToDraft(app, prepareAttachment([item, { ...item, id: 'b' }], ['a', 'b']));
    assert.equal(received[2].params.content[0]._meta['openai/title'], 'Multiple contexts');
    assert.equal(received[2].params.content[0].text, buildContext([item, { ...item, id: 'b' }]));
  } finally { await app.close(); await host.close(); }
});

test('missing message extension, malformed payload or host rejection cannot produce success or fallback send', async () => {
  let calls = 0;
  const host = { getHostCapabilities: () => ({ message: { text: {} }, experimental: {} }), sendMessage: async () => { calls++; return {}; } };
  assert.equal(draft.supportsDraft(host), false);
  await assert.rejects(draft.addAttachmentToDraft(host, prepareAttachment([item], ['a'])), { message: draft.DRAFT_UNAVAILABLE });
  assert.equal(calls, 0);
  host.getHostCapabilities = () => ({ message: { text: {} }, experimental: { 'openai/message': {} } });
  await assert.rejects(draft.addAttachmentToDraft(host, { title: 'bad', ids: ['a'], content: [{ type: 'text', text: 'paste this' }] }), /invalid/);
  assert.equal(calls, 0);
  host.sendMessage = async () => { calls++; return { isError: true }; };
  await assert.rejects(draft.addAttachmentToDraft(host, prepareAttachment([item], ['a'])), /did not accept/);
  assert.equal(calls, 1);
});

test('a restored panel without the transient draft hint can retry after its composer mounts', async () => {
  const app = new App({ name: 'restored panel', version: '1' }, {}, { autoResize: false });
  const [view, host] = InMemoryTransport.createLinkedPair();
  const received = [];
  host.onmessage = async request => {
    if (request.id === undefined) return;
    if (request.method === 'ui/initialize') {
      await host.send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion,
        hostInfo: { name: 'test host', version: '1' }, hostContext: {},
        hostCapabilities: { message: { text: {} }, experimental: { 'openai/message': {} } } } });
    } else if (request.method === 'ui/message') {
      received.push(request);
      await host.send(received.length === 1
        ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'The composer is unavailable' } }
        : { jsonrpc: '2.0', id: request.id, result: {} });
    }
  };
  await host.start();
  try {
    await app.connect(view);
    assert.equal(draft.supportsDraft(app), true);
    const attachment = prepareAttachment([item], ['a']);
    await assert.rejects(draft.addAttachmentToDraft(app, attachment), /composer is unavailable/);
    assert.equal(received.length, 1, 'an uncertain write must never retry automatically');
    assert.equal(draft.supportsDraft(app), true, 'a temporarily absent composer must not permanently disable Add');
    await draft.addAttachmentToDraft(app, attachment);
    assert.equal(received.length, 2);
    for (const request of received) {
      assert.deepEqual(request.params._meta['openai/message'], { target: 'active', send: false });
      assert.equal(request.params.content[0].text, buildContext([item]));
    }
  } finally { await app.close(); await host.close(); }
});

test('draft actions need the message extension and text transport, not a host name or legacy hint', () => {
  for (const capabilities of [undefined, {}, { message: { text: {} } },
    { experimental: { 'openai/message': {} } },
    { message: { text: {} }, experimental: { 'openai/message': null } },
    { message: { text: {} }, experimental: { 'openai/message': [] } }]) {
    assert.equal(draft.supportsDraft({ getHostCapabilities: () => capabilities }), false);
  }
  assert.equal(draft.supportsDraft({ getHostCapabilities: () => ({
    message: { text: {} }, experimental: { 'openai/message': {} },
  }) }), true);
});

test('portable plugin stdio server starts independently from its shipped bundle', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stashdock-mcp-test-stdio-'));
  // macOS ignores APPDATA/XDG_DATA_HOME. Isolate os.homedir in this child only,
  // without changing HOME or touching the user's authoritative registration.
  const profile = join(dataDir, 'profile');
  const bootstrap = join(dataDir, 'isolated-profile.mjs');
  writeFileSync(bootstrap, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(profile)}; syncBuiltinESMExports();`);
  const client = new Client({ name: 'portable test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(bootstrap).href, new URL('../plugins/stashdock/scripts/mcp-server.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    // The override seeds a new user anchor; it cannot fork an existing user's
    // library. Isolate the profile registration as well as the database.
    env: { ...process.env, STASHDOCK_DATA_DIR: dataDir, APPDATA: join(dataDir, 'profile'), XDG_DATA_HOME: join(dataDir, 'profile') }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    try { await client.connect(transport); }
    catch (error) { await new Promise(resolve => setTimeout(resolve, 200)); throw Error(`${error.message}\nserver stderr:\n${stderr.slice(-2000)}`); }
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'open_stashdock'));
    const tools = (await client.listTools()).tools;
    assert.ok(!tools.some(tool => tool.name === 'get_stashdock_dock_url'));
    assert.ok(tools.some(tool => tool.name === 'get_stashdock_file'));
    const shelf = await client.callTool({ name: 'list_stashdock_shelf', arguments: {} });
    assert.equal(shelf.isError, undefined);
    assert.equal(shelf._meta.items.length, 0);
  } finally { await client.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
