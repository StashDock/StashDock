import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { restoreWindowsDataDirectory } from '../stashdock/scripts/windows-data-directory.mjs';
import { registerBrowserHost } from '../stashdock/scripts/register-browser-host.mjs';
import { ROUTE, PANEL_ID } from './protocol.mjs';
import { registerFiles } from './files.mjs';
import manifest from './package.json' with { type: 'json' };

export const name = PANEL_ID;
export const inject = ['connection', 'webServer', 'tools', 'skills'];

const modelTools = new Set([
  'search_stashdock', 'list_stashdock_tags', 'get_stashdock_items', 'get_stashdock_item',
  'get_stashdock_file', 'save_stashdock_reference', 'apply_stashdock_tag_changes',
]);
const htmlUrl = new URL('./runtime/web/shelf.html', import.meta.url);
const noCache = { 'cache-control': 'no-store' };

export function apply(ctx) {
  // The library and native file picker belong to the local workstation.
  const bindHost = ctx.webServer.host;
  const loopback = bindHost === 'localhost' || bindHost === '::1' ||
    (typeof bindHost === 'string' && isIPv4(bindHost) && bindHost.startsWith('127.'));
  if (!loopback || ctx.connection.allowsRemoteAuthorities) return;
  let connection;
  let closed = false;
  const disposers = [];
  const connect = () => connection ??= (async () => {
    const { createServer } = await import('./runtime/dist/mcp-server.mjs');
    if (closed) throw Error('StashDock was unloaded.');
    restoreWindowsDataDirectory();
    const server = createServer({ htmlUrl, previewWorker: true, pluginKind: 'dsh', pluginVersion: manifest.version,
      installationPath: fileURLToPath(new URL('./package.json', import.meta.url)) });
    void registerBrowserHost({ root: new URL('./runtime/', import.meta.url), ensure: true });
    const client = new Client({ name: 'StashDock for DeepSeek Harness', version: manifest.version });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      return { client, server, tools };
    } catch (error) {
      await server.close();
      throw error;
    }
  })().catch(error => {
    connection = undefined;
    throw error;
  });

  // Exact Fetch routes inherit DSH's owner-only browser authentication.
  ctx.connection.fetch.register({
    path: `/${ROUTE}/shelf`, methods: ['GET'], requestBody: 'buffered',
    async fetch({ signal }) {
      const html = await readFile(htmlUrl, { encoding: 'utf8', signal });
      return Response.json(html, { headers: noCache });
    },
  });
  ctx.connection.fetch.register({
    path: `/${ROUTE}/tool`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (closed) return new Response('StashDock was unloaded.', { status: 503 });
      if (request.headers.get('content-type') !== 'application/json') return new Response('Expected JSON.', { status: 415 });
      const payload = await request.json().catch(() => null);
      if (typeof payload?.name !== 'string') return new Response('Unknown StashDock operation.', { status: 400 });
      const { client, tools } = await connect();
      if (!tools.some(tool => tool.name === payload.name && tool._meta?.ui?.visibility?.includes('app'))) {
        return new Response('This operation is unavailable in the shelf.', { status: 403 });
      }
      const result = await client.callTool({ name: payload.name, arguments: payload.arguments }, undefined,
        { signal: request.signal, timeout: 660_000 });
      return Response.json(result, { headers: noCache });
    },
  });

  // Listing schemas opens the shared server on demand. Register the tool
  registerFiles(ctx, connect, () => closed);

  // catalog at startup without reading any saved references.
  void (async () => {
    try {
      const { client, tools } = await connect();
      if (closed) return;
      for (const tool of tools.filter(tool => modelTools.has(tool.name))) {
        disposers.push(ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
          async execute(args, { signal }) {
            const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal });
            const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            if (result.isError) throw Error(text);
            return text;
          },
        }));
      }
      const skill = await readFile(new URL('./runtime/skills/use-stashdock/SKILL.md', import.meta.url), 'utf8');
      if (!closed) disposers.push(ctx.skills.register({
        name: 'use-stashdock',
        description: 'Find, reuse, save, and organize context in the local StashDock library.',
        content: skill.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, ''),
      }));
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) dispose();
      if (!closed) console.error('[StashDock]', error.message);
    }
  })();
  ctx.on('dispose', async () => {
    closed = true;
    for (const dispose of disposers.splice(0).reverse()) dispose();
    const runtime = await connection?.catch(() => undefined);
    await runtime?.server.close();
  });
}
