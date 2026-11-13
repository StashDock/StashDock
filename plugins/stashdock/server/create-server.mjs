import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIUiToolMetadataSchema, OpenAIUiResourceMetadataSchema } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { detail, faviconOrigins, prepareAttachment, search, summary, visualSummary } from './library.mjs';
import { createLocalLibrary } from './local-library.mjs';
import { startCaptureBridge } from './capture-bridge.mjs';
import { startPreviewWorker, packagedPreviewService } from './preview-worker.mjs';
import { buildContext, editorContext } from '../../../src/lib/context-format.mjs';
import { openCaptureSite } from './open-capture-site.mjs';
import { createIntegrationStatusReader } from './integration-status.mjs';
import { openIntegration } from './open-integration.mjs';
import { readStorageInfo } from './settings.mjs';
import { createStorageService } from './storage-service.mjs';
import { checkPluginUpdates } from './plugin-updates.mjs';
import productLinks from '../../../src-tauri/product-links.json' with { type: 'json' };
// One plugin version: the manifest the host installs and caches by.
import { fileURLToPath } from 'node:url';
import { contextSaveSchema, readContextBatch, tagCatalog } from './ai-context.mjs';

import pluginManifest from '../.codex-plugin/plugin.json' with { type: 'json' };
const PLUGIN_VERSION = pluginManifest.version;
export const SHELF_URI = `ui://stashdock/shelf-${PLUGIN_VERSION}.html`;
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const searchSchema = { query: z.string().max(1000).optional(), tag: z.string().max(200).optional(),
  favoriteOnly: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(100_000).optional() };
const valueResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const guarded = callback => async args => {
  try { return await callback(args); }
  catch (error) { return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }; }
};

export function createServer({ dataDir, captureBridge = false, captureBridgePort = 17864, previewWorker = captureBridge, htmlUrl, importServices, storageServices,
  pluginKind = 'chatgpt', pluginVersion = PLUGIN_VERSION, installationPath }) {
  const library = createLocalLibrary({ dataDir });
  const readIntegrationStatus = createIntegrationStatusReader(library);
  const storageService = storageServices || createStorageService(library, htmlUrl);
  if (pluginKind === 'dsh' && installationPath) library.registerInstallation('dsh', pluginVersion, installationPath);
  else if (captureBridge) library.registerInstallation('codex', PLUGIN_VERSION, fileURLToPath(new URL('../.codex-plugin/plugin.json', htmlUrl)));
  const previewService = packagedPreviewService(htmlUrl, library.dataDir || dataDir);
  importServices ??= { readBrowser: previewService.readBrowser, sources: previewService.sources, bookmarks: previewService.bookmarks, icons: previewService.icons, preview: previewService.lookup, openCaptureSite };
  const prepareCover = importServices.prepareCover ?? previewService.prepareCover;
  const normalizeCover = async value => {
    if (typeof value !== 'string' || value.length > 750_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('Use a prepared PNG, JPG or WebP cover image.');
    return prepareCover(value.split(',')[1]);
  };
  const bridge = captureBridge ? startCaptureBridge(library, captureBridgePort) : undefined;
  const previews = previewWorker ? startPreviewWorker(library.dataDir, htmlUrl, previewService) : undefined;
  const iconUrl = new URL('../assets/icon.png', htmlUrl);
  const icons = [{ src: `data:image/png;base64,${readFileSync(iconUrl).toString('base64')}`, mimeType: 'image/png' }];
  const server = new McpServer({ name: 'stashdock', version: pluginVersion, icons });
  const close = server.close.bind(server);
  server.close = async () => { storageService.close?.(); bridge?.close(); await Promise.all([previewService.close(), previews?.close()]); await close(); library.close?.(); };
  let resourceDomains = [];
  // Matching uses the shared SQLite index; only compact rows are read for filtering.
  const searchLibrary = async args => {
    if (!library.searchIds) return search(await (library.readIndex?.(Boolean(args.query?.trim())) ?? library.read()), args);
    const rankedIds = library.searchIds(args.query) ?? undefined;
    return search(await (library.readIndex?.() ?? library.read(true)), { ...args, rankedIds });
  };
  server.registerTool('search_stashdock', { description: 'Find saved context for a task, or browse a tag as a reusable context group. Every space-separated word must appear (substring match, any language); most relevant first, then newest. Use a few short keywords rather than a sentence; use hasMore/nextOffset to page. Read promising candidates with get_stashdock_items.',
    inputSchema: searchSchema, annotations: readOnly }, guarded(async args => {
    const result = await searchLibrary(args), matches = result.items.map(summary);
    return valueResult({ count: matches.length, items: matches, hasMore: result.hasMore,
      nextOffset: result.hasMore ? (args.offset || 0) + matches.length : null });
  }));
  server.registerTool('list_stashdock_tags', {
    description: 'Find existing tags and reference counts. Tags are StashDock context groups; use search_stashdock with tag to browse their references. Does not create or modify tags.',
    inputSchema: { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(100_000).optional() },
    annotations: readOnly,
  }, guarded(async args => valueResult(tagCatalog(await (library.readIndex?.() ?? library.read(true)), args))));
  server.registerTool('get_stashdock_items', {
    description: 'Read bounded context for up to 10 candidate references in selection order. Honors the saved final context; reports truncation and file availability. Does not read original binary files, add draft attachments or send messages.',
    inputSchema: { ids: z.array(z.string().min(1).max(200)).min(1).max(10), maxCharacters: z.number().int().min(2000).max(120_000).optional() },
    annotations: readOnly,
  }, guarded(async ({ ids, maxCharacters }) => valueResult(readContextBatch(await (library.readItems?.(ids) ?? library.read()), ids, maxCharacters))));
  server.registerTool('save_stashdock_reference', {
    description: 'Create one context note or web-link reference only when the user asks to save specified content to StashDock. Use existing tags for context groups. For ambiguous or newly synthesized content, agree the content before saving. No URL fetch, arbitrary file paths, overwrite or deletion. Retries deduplicate; already_saved keeps existing content and reports whether the submitted body matches.',
    inputSchema: contextSaveSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guarded(async args => {
    const { item, ...result } = library.saveContextReference(args);
    return valueResult({ ...result, item: summary(item) });
  }));
  const modelTagList = z.array(z.string().trim().min(1).max(48)).max(12).default([]);
  server.registerTool('apply_stashdock_tag_changes', {
    description: 'Apply tag additions/removals that the user explicitly requested or approved after reviewing a proposed organization plan. Preserves every unmentioned tag. Each change must use the latest tagRevision from search/read results; references changed since review are skipped and reported. Never use this tool to make an unreviewed broad reorganization.',
    inputSchema: {
      changes: z.array(z.object({
        id: z.string().min(1).max(200),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        addTags: modelTagList,
        removeTags: modelTagList,
      }).strict().refine(value => value.addTags.length > 0 || value.removeTags.length > 0, 'Add or remove at least one tag.')).min(1).max(30),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guarded(async ({ changes }) => valueResult(library.applyTagChanges(changes))));
  server.registerTool('get_stashdock_item', { description: 'Retrieve one saved reference and its full captured text.',
    inputSchema: { id: z.string().min(1).max(200) }, annotations: readOnly }, guarded(async ({ id }) => {
    const item = (await (library.readItems?.([id]) ?? library.read())).find(value => value.id === id);
    if (!item) throw new Error('No StashDock reference found for this ID.');
    return valueResult(detail(item));
  }));
  server.registerTool('get_stashdock_file', {
    description: 'Resolve the original file of a user-selected StashDock reference by its ID. Returns a validated local path, not parsed content or an uploaded attachment. Read it with the host file tools (for example the spreadsheet skill for Excel) before answering about its contents. If unavailable or blocked, say which original was not read; never infer its contents from the title, excerpt or path. Never execute the file or its macros.',
    inputSchema: { id: z.string().min(1).max(200) }, annotations: readOnly,
  }, guarded(async ({ id }) => valueResult(library.resolveFile(id))));

  registerAppResource(server, 'StashDock shelf', SHELF_URI, { description: 'Select saved references and add them to the current draft.' },
    async () => {
      try { resourceDomains = faviconOrigins(await (library.readIndex?.() ?? library.read(true))); }
      catch { resourceDomains = []; /* Keep the UI reachable to show its library error. */ }
      return { contents: [{ uri: SHELF_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(htmlUrl, 'utf8'),
        _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains } },
          'openai/ui': OpenAIUiResourceMetadataSchema.parse({ preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] }) } }] };
    });
  registerAppTool(server, 'open_stashdock', {
    title: 'StashDock', description: 'Open the visual StashDock library. Users can also open it directly from global navigation or a conversation panel.',
    inputSchema: {}, annotations: readOnly,
    _meta: { ui: { resourceUri: SHELF_URI }, 'openai/ui': OpenAIUiToolMetadataSchema.parse({ entrypoints: [{ type: 'global' }, { type: 'thread' }], preferredModelDisplayMode: 'fullscreen' }) },
  }, async () => valueResult({ app: 'StashDock', status: 'ready', resourceUri: SHELF_URI }));
  // App-only data tools do not attach a UI template: searches must not remount it.
  server.registerTool('list_stashdock_shelf', {
    description: 'Read the visual shelf, without full captured bodies. Only called from the MCP App.',
    inputSchema: { ...searchSchema, sort: z.enum(['newest', 'oldest', 'most-used']).optional(), collection: z.enum(['all', 'recent', 'web', 'files', 'favorites']).optional(), offset: z.number().int().min(0).max(100_000).optional() }, annotations: readOnly,
    _meta: { ui: { visibility: ['app'] } },
  }, guarded(async args => {
    if (library.readShelf) {
      const result = await library.readShelf(args);
      return { ...valueResult({ count: result.items.length, hasMore: result.hasMore }),
        _meta: { items: result.items.map(item => visualSummary(item, resourceDomains)), tags: result.tags, sort: result.sort } };
    }
    const rows = await library.read();
    const sort = args.sort ?? library.getSort?.() ?? 'newest';
    const matches = search(rows, { ...args, sort, limit: args.limit ?? 30 });
    const counts = new Map();
    for (const row of rows) for (const tag of row.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    return { ...valueResult({ count: matches.items.length, hasMore: matches.hasMore }),
      _meta: { items: matches.items.map(item => visualSummary(item, resourceDomains)), sort, tags: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })) } };
  }));
  server.registerTool('select_stashdock_shelf', {
    description: 'Read IDs of all references matching the current shelf filters. Does not change the draft or library.',
    inputSchema: { query: searchSchema.query, tag: searchSchema.tag, collection: z.enum(['all', 'recent', 'web', 'files', 'favorites']).optional() },
    annotations: readOnly, _meta: { ui: { visibility: ['app'] } },
  }, guarded(async args => {
    const ids = (await searchLibrary({ ...args, limit: Number.MAX_SAFE_INTEGER })).items.map(item => item.id);
    return { ...valueResult({ count: ids.length }), _meta: { ids } };
  }));
  server.registerTool('prepare_stashdock_attachment', {
    description: 'Prepare a read-only Markdown snapshot of selected saved references. Does not send a message or modify the draft.',
    inputSchema: { ids: z.array(z.string().min(1).max(200)).min(1).max(30), fileDelivery: z.enum(['tools', 'native']).optional() }, annotations: readOnly,
    _meta: { ui: { visibility: ['app'] } },
  }, guarded(async ({ ids, fileDelivery }) => {
    const rows = await (library.readItems?.(ids) ?? library.read());
    // Fail before draft feedback when an original is missing or escapes assets.
    for (const item of rows.filter(item => ids.includes(item.id) && item.kind !== 'note' && item.assetPath)) library.resolveFile(item.id);
    const attachment = prepareAttachment(rows, ids, fileDelivery);
    return { ...valueResult({ title: attachment.title, ids: attachment.ids }), _meta: { attachment } };
  }));
  const appOnly = { ui: { visibility: ['app'] } };
  server.registerTool('set_stashdock_sort', {
    description: 'Save the reference order selected in the library menu.',
    inputSchema: { sort: z.enum(['newest', 'oldest', 'most-used']) },
    annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, guarded(async ({ sort }) => { await library.setSort(sort); return valueResult({ sort }); }));
  server.registerTool('record_stashdock_use', {
    description: 'Record references after the host has accepted Add to chat. Never call before draft delivery succeeds.',
    inputSchema: { ids: z.array(z.string().min(1).max(120)).min(1).max(10000), operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/) },
    annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, guarded(async ({ ids, operationId }) => valueResult(await library.recordUse(ids, operationId))));
  server.registerTool('open_stashdock_integration', {
    description: 'Open the app chosen in StashDock Settings. Prefer its installed client, otherwise its official website.',
    inputSchema: { id: z.enum(['chrome', 'edge', 'firefox', 'safari', 'codex', 'dsh', 'claude', 'desktop']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: appOnly,
  }, guarded(async ({ id }) => valueResult(await openIntegration(id, { desktopPath: library.desktopExecutable?.() }))));
  server.registerTool('get_stashdock_integrations', {
    description: 'Read current StashDock installation and enablement metadata. Does not change installations.', inputSchema: {}, annotations: readOnly, _meta: appOnly,
  }, guarded(async () => {
    if (!library.integrations) throw Error('Installation status requires the local library.');
    return { ...valueResult({}), _meta: { integrations: await readIntegrationStatus() } };
  }));
  server.registerTool('get_stashdock_settings', {
    description: 'Read interface preferences for the Codex panel. Desktop appearance is independent.', inputSchema: {}, annotations: readOnly, _meta: appOnly,
  }, guarded(async () => {
    if (!library.getCodexPreferences) throw Error('Settings require the independent local library.');
    const repository = productLinks.githubRepository;
    const githubUrl = typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}` : null;
    return { ...valueResult({}), _meta: { settings: { preferences: library.getCodexPreferences(), version: pluginVersion, githubUrl } } };
  }));
  server.registerTool('check_stashdock_plugin_updates', {
    description: 'Check GitHub Releases for a newer StashDock plugin package, from Settings. Does not download or install anything.', inputSchema: {},
    annotations: { ...readOnly, openWorldHint: true }, _meta: appOnly,
  }, guarded(async () => ({ ...valueResult({}), _meta: { update: await checkPluginUpdates({
    repository: productLinks.githubRepository, current: pluginVersion, pluginKind,
  }) } })));
  server.registerTool('save_stashdock_preferences', {
    description: 'Save only the language or theme explicitly chosen in the Codex panel. Does not change desktop preferences.',
    inputSchema: { preferences: z.object({ language: z.enum(['system', 'en', 'zh']).optional(), theme: z.enum(['system', 'light', 'dark']).optional() }).strict().refine(value => Object.keys(value).length > 0) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: appOnly,
  }, guarded(async ({ preferences }) => {
    if (!library.saveCodexPreferences) throw Error('Settings require the independent local library.');
    return { ...valueResult({ saved: true }), _meta: { preferences: library.saveCodexPreferences(preferences) } };
  }));
  server.registerTool('get_stashdock_storage_info', {
    description: 'Read used space, count and location of the shared local library. Does not move or open anything.', inputSchema: {}, annotations: readOnly, _meta: appOnly,
  }, guarded(async () => {
    if (!library.dataDir) throw Error('Storage details require the independent local library.');
    return { ...valueResult({}), _meta: { storage: await readStorageInfo(library) } };
  }));
  server.registerTool('open_stashdock_storage_folder', {
    description: 'Open the current library folder from Settings.', inputSchema: {}, annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, guarded(async () => { await storageService.open(); return valueResult({ opened: true }); }));
  server.registerTool('choose_stashdock_storage_location', {
    description: 'Open the native folder picker from Settings. Does not move data.', inputSchema: { title: z.string().max(200).optional() }, annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, guarded(async ({ title }) => ({ ...valueResult({}), _meta: { destination: await storageService.choose(title || 'Choose an empty folder') } })));
  server.registerTool('move_stashdock_storage', {
    description: 'Move the library to the folder selected in Settings, after explicit confirmation.', inputSchema: { token: z.string().min(1).max(100) }, annotations: { ...readOnly, readOnlyHint: false, idempotentHint: false }, _meta: appOnly,
  }, guarded(async ({ token }) => ({ ...valueResult({ moved: true }), _meta: { storage: await storageService.move(token) } })));
  server.registerTool('prepare_stashdock_cover', {
    description: 'Prepare a bounded thumbnail from an image explicitly selected in the App. Does not save or change a reference.',
    inputSchema: { base64: z.string().min(1).max(6_666_668) }, annotations: readOnly, _meta: appOnly,
  }, guarded(async ({ base64 }) => ({ ...valueResult({ status: 'ready' }), _meta: { preview: await prepareCover(base64) } })));
  server.registerTool('list_stashdock_capture_platforms', {
    description: 'Read user-saved website destinations for the platform picker.', inputSchema: {}, annotations: readOnly, _meta: appOnly,
  }, guarded(async () => ({ ...valueResult({}), _meta: { platforms: await library.listCapturePlatforms?.() || [] } })));
  server.registerTool('save_stashdock_capture_platform', {
    description: 'Save a website destination explicitly entered by the user. Does not sign in or import content.',
    inputSchema: { url: z.string().min(1).max(2048) }, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guarded(async ({ url }) => {
    if (!library.saveCapturePlatform) throw Error('Custom platforms require the current local library.');
    return { ...valueResult({ saved: true }), _meta: { platforms: await library.saveCapturePlatform(url) } };
  }));
  server.registerTool('open_stashdock_capture_site', {
    description: 'Open the site selected by the user in their normal default browser. Save individual pages with the browser extension. No sign-in automation or collection import.',
    inputSchema: { site: z.string().min(1).max(2060) },
    annotations: { readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true }, _meta: appOnly,
  }, guarded(async ({ site }) => {
    if (!importServices.openCaptureSite) throw Error('Browser navigation is unavailable. Open the website in your browser and use the StashDock extension.');
    return valueResult(await importServices.openCaptureSite(site, { customPlatforms: await library.listCapturePlatforms?.() || [] }));
  }));
  server.registerTool('list_stashdock_import_sources', {
    description: 'Discover installed browser bookmark sources for the import picker. Does not import anything.',
    inputSchema: {}, annotations: readOnly, _meta: appOnly,
  }, guarded(async () => {
    const sources = await importServices.sources();
    const existingUrls = (await (library.readIndex?.() ?? library.read(true))).flatMap(item => item.url ? [item.url] : []);
    return { ...valueResult({ count: sources.length }), _meta: { sources, existingUrls } };
  }));
  server.registerTool('read_stashdock_browser_import', {
    description: 'Read the browser chosen in the App, requesting native folder access only after its Read bookmarks button. Returns a preview; never saves references.',
    inputSchema: { browser: z.enum(['Chrome', 'Edge', 'Firefox', 'Safari']), requestAccess: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: appOnly,
  }, guarded(async ({ browser, requestAccess }) => {
    if (!importServices.readBrowser) throw Error('Update the StashDock plugin to read browser bookmarks.');
    return { ...valueResult({}), _meta: { state: await importServices.readBrowser(browser, requestAccess) } };
  }));
  server.registerTool('read_stashdock_browser_bookmarks', {
    description: 'Read bookmarks from a browser selected in the App. Does not change the browser or library.',
    inputSchema: { sourceId: z.string().min(1).max(300) }, annotations: readOnly, _meta: appOnly,
  }, guarded(async ({ sourceId }) => {
    const bookmarks = await importServices.bookmarks(sourceId);
    return { ...valueResult({ count: bookmarks.length }), _meta: { bookmarks } };
  }));
  server.registerTool('preview_stashdock_link', {
    description: 'Read the public page selected in the App to suggest its title, content and favicon. Does not save it.',
    inputSchema: { url: z.string().min(1).max(8192) }, annotations: { ...readOnly, openWorldHint: true }, _meta: appOnly,
  }, guarded(async ({ url }) => ({ ...valueResult({ status: 'ready' }), _meta: { preview: await importServices.preview(url) } })));
  server.registerTool('read_stashdock_bookmark_icons', {
    description: 'Read public-site icons for bookmark rows shown in the App. Does not import anything.',
    inputSchema: { urls: z.array(z.string().min(1).max(8192)).max(12) }, annotations: { ...readOnly, openWorldHint: true }, _meta: appOnly,
  }, guarded(async ({ urls }) => ({ ...valueResult({ status: 'ready' }), _meta: { icons: await importServices.icons?.(urls) ?? {} } })));
  server.registerTool('get_stashdock_context', {
    description: 'Read the final context for the App content editor.',
    inputSchema: { id: z.string().min(1).max(200) }, annotations: readOnly, _meta: appOnly,
  }, guarded(async ({ id }) => {
    const item = (await (library.readItems?.([id]) ?? library.read())).find(value => value.id === id);
    if (!item) throw new Error('This reference no longer exists. Refresh the shelf.');
    return { ...valueResult({ id }), _meta: { item, context: editorContext(item) } };
  }));
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const id = z.string().min(1).max(200);
  const tagList = z.array(z.string().trim().min(1).max(48)).max(12);
  const registerWrite = (name, description, inputSchema, callback, destructive = false, idempotent = true) => server.registerTool(name, {
    description, inputSchema, annotations: { ...write, destructiveHint: destructive, idempotentHint: idempotent }, _meta: appOnly,
  }, guarded(async args => valueResult(await callback(args))));
  registerWrite('import_stashdock_references', 'Import references explicitly chosen in the App.', {
    items: z.array(z.object({ title: z.string().min(1).max(500), kind: z.enum(['web', 'repo', 'note']), source: z.string().max(300),
      url: z.string().max(8192).optional(), excerpt: z.string().max(2_000_000), content: z.string().max(2_000_000).optional(),
      tags: tagList, createdAt: z.string().max(64), favorite: z.boolean().optional(), preview: z.string().max(750_000).optional(), origin: z.record(z.string(), z.unknown()).optional() })).min(1).max(500),
  }, async ({ items }) => {
    const prepared = [];
    for (const item of items) prepared.push(item.origin?.previewSource === 'custom' ? { ...item, preview: await normalizeCover(item.preview) } : item);
    const { items: rows, ...counts } = library.importItems(prepared); return counts;
  }, false, false);
  registerWrite('replace_stashdock_link', 'Replace the saved reference with the new link capture after the user confirms in the App.', {
    item: z.object({ title: z.string().min(1).max(500), kind: z.enum(['web', 'repo']), source: z.string().max(300),
      url: z.string().min(1).max(8192), excerpt: z.string().max(2_000_000), content: z.string().max(2_000_000).optional(),
      tags: tagList, createdAt: z.string().max(64), favorite: z.boolean().optional(), preview: z.string().max(750_000).optional(), origin: z.record(z.string(), z.unknown()).optional() }),
  }, async ({ item }) => {
    const prepared = item.origin?.previewSource === 'custom' ? { ...item, preview: await normalizeCover(item.preview) } : item;
    const saved = library.replaceLink(prepared);
    return { id: saved.id, replaced: true };
  }, false, true);
  registerWrite('import_stashdock_files', 'Save managed copies of files explicitly selected by the user. No arbitrary file paths.', {
    files: z.array(z.object({ name: z.string().min(1).max(300), mimeType: z.string().max(200), base64: z.string().max(6_666_668), title: z.string().trim().min(1).max(500).optional(), content: z.string().max(50_000).optional(), preview: z.string().max(750_000).optional() })).min(1).max(10),
    tags: tagList.optional(),
  }, async ({ files, tags }) => {
    const prepared = [];
    for (const file of files) prepared.push(file.preview === undefined ? file : { ...file, preview: await normalizeCover(file.preview) });
    return { items: library.importFiles(prepared, tags).map(summary) };
  }, false, false);
  // System-dialog imports reference the user's original file; the App only sees tokens.
  server.registerTool('choose_stashdock_files', {
    description: 'Open the system file dialog from the App import form. Stages chosen files for an explicit Save; does not import anything.',
    inputSchema: {}, annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, guarded(async () => {
    if (!storageService.chooseFiles) throw Error('Update the StashDock plugin to choose files.');
    const paths = await storageService.chooseFiles('Choose files');
    return { ...valueResult({ count: paths.length }), _meta: { files: library.describeChosenFiles(paths) } };
  }));
  registerWrite('import_stashdock_chosen_files', 'Save files chosen in the system dialog as references to their originals, with the edits made in the App.', {
    files: z.array(z.object({ token: z.string().min(1).max(100), title: z.string().trim().min(1).max(500), content: z.string().max(50_000), preview: z.string().max(750_000).optional() }).strict()).min(1).max(10),
    tags: tagList.optional(),
  }, async ({ files, tags }) => {
    const prepared = [];
    for (const file of files) prepared.push(file.preview === undefined ? file : { ...file, preview: await normalizeCover(file.preview) });
    return { items: (await library.importChosenFiles(prepared, tags)).map(summary) };
  }, false, false);
  registerWrite('open_stashdock_file', 'Open a saved file in its default application. Accepts a reference ID, not a path.', { id }, ({ id }) => library.openFile(id), false);
  registerWrite('set_stashdock_favorite', 'Set a reference favorite from its App button.', { id, favorite: z.boolean() }, args => ({ item: summary(library.setFavorite(args.id, args.favorite)) }));
  registerWrite('set_stashdock_tags', 'Replace tags on references selected by the user in the App.', { ids: z.array(id).min(1).max(30), tags: tagList }, args => ({ items: library.setTags(args.ids, args.tags).map(summary) }));
  registerWrite('edit_stashdock_reference', 'Save the title, tags and optional cover explicitly edited in the App.', { id, title: z.string().trim().min(1).max(500), tags: tagList, cover: z.object({ preview: z.string().max(750_000).nullable() }).strict().optional() }, async args => {
    let cover;
    if (args.cover) {
      if (args.cover.preview !== null) cover = { preview: await normalizeCover(args.cover.preview) };
      else {
        let defaultPreview;
        try { const original = library.defaultCover(args.id); if (original) defaultPreview = await prepareCover(original); }
        catch { /* Missing/unsupported original: use the normal file identity fallback. */ }
        cover = { preview: null, defaultPreview };
      }
    }
    return { item: summary(library.editMetadata(args.id, args.title, args.tags, cover)) };
  });
  registerWrite('edit_stashdock_context', 'Save the final AI context explicitly edited in the App.', { id, context: z.string().max(200_000) }, args => ({ item: summary(library.editContext(args.id, args.context)) }));
  registerWrite('rename_stashdock_tag', 'Rename a tag across the local library after user confirmation.', { name: z.string().min(1).max(48), replacement: z.string().min(1).max(48) }, args => library.changeTag(args.name, args.replacement));
  registerWrite('delete_stashdock_tag', 'Remove a tag from all references after user confirmation. References remain saved.', { name: z.string().min(1).max(48) }, args => library.changeTag(args.name, null), true);
  registerWrite('delete_stashdock_reference', 'Delete a reference after the user confirms in the App. Original files and sites remain unchanged.', { id }, args => library.remove(args.id), true);
  registerWrite('delete_stashdock_references', 'Delete references selected and confirmed in the App. Original files and sites remain unchanged.', { ids: z.array(z.string().min(1).max(120)).min(1).max(10_000) }, args => library.removeMany(args.ids), true);
  return server;
}

export async function run(htmlUrl) {
  // An isolated stdio check must not advertise its fixture library on the
  // normal browser port. Keep preview verification available without a bridge.
  const server = createServer({ htmlUrl,
    captureBridge: process.env.STASHDOCK_NATIVE_HOST_REGISTRATION !== 'off', previewWorker: true });
  await server.connect(new StdioServerTransport());
}
