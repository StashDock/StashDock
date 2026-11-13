// Compatibility bridge for older extensions. Current saves use the browser-
// owned native helper with Desktop and the AI host closed; no offline Save queue.
import { createServer } from 'node:http';
import { openIntegration } from './open-integration.mjs';
import { browserRegistration, nativeFirefoxOrigin, nativeSafariOrigin } from '../../../src/lib/browser-extension-identity.mjs';
export function startCaptureBridge(library, port = 17864, { openApp = openIntegration } = {}) {
  let closed = false, retry;
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const extension = typeof origin === 'string' && (nativeFirefoxOrigin(origin) || nativeSafariOrigin(origin) || /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin));
    const registered = extension && library.browserOriginAllowed?.(origin) === true;
    const boundPort = server.address()?.port || port;
    const allowedHost = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(request.headers.host);
    if (!allowedHost || (origin && !extension)) { response.writeHead(403); response.end(); return; }
    if (extension) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-StashDock-Client');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (request.method === 'OPTIONS' && extension) { response.writeHead(204); response.end(); return; }
    if (request.headers['x-stashdock-client'] !== 'chrome-extension-v1') { response.writeHead(403); response.end(); return; }
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const publicRoute = request.url === '/v1/health' || request.url === '/v1/setup';
    if (!publicRoute && !registered) {
      response.writeHead(403); response.end(JSON.stringify({ error: 'Run StashDock setup from this extension first.' })); return;
    }
    try {
      let result;
      if (request.method === 'GET' && request.url === '/v1/health') result = { status: 'ready', app: 'StashDock library' };
      else if (request.method === 'POST' && request.url === '/v1/setup') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw Error('Use a JSON request.');
        let body = '', size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 4096) throw Error('Invalid setup request.'); body += chunk; }
        const { browser, version, extensionId: reportedId } = JSON.parse(body);
        const extensionId = browserRegistration(browser, origin, reportedId);
        library.registerInstallation(browser, version, undefined, extensionId, origin);
        // Setup acknowledges this origin, not every installed application.
        // Keep the empty legacy field for existing clients; Settings owns scans.
        result = { connected: true, owner: 'codex', integrations: { items: [] } };
      }
      else if (request.method === 'POST' && request.url === '/v1/open-integration') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw Error('Use a JSON request.');
        let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024) throw Error('Invalid application request.'); }
        const input = JSON.parse(body);
        if (!input || Object.keys(input).join(',') !== 'id' || !['chrome','edge','firefox','codex','dsh','claude','desktop'].includes(input.id)) throw Error('Choose a supported StashDock app.');
        result = await openApp(input.id, { desktopPath: library.desktopExecutable?.() });
      }
      else if (['GET','POST'].includes(request.method) && request.url === '/v1/tags') result = { tags: library.captureTags() };
      else if (request.method === 'POST' && request.url === '/v1/capture/lookup') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw Error('Use a JSON request.');
        let size=0,chunks=[];
        for await(const chunk of request){size+=chunk.length;if(size>16384)throw Error('Invalid lookup request.');chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!input || typeof input.url!=='string' || input.url.length>8000 || Object.keys(input).some(key=>!['url','operationId','digest'].includes(key)))throw Error('Invalid lookup request.');
        result=library.lookupCapture(input.url,input.operationId,input.digest);
      }
      else if (request.method === 'GET' && request.url?.startsWith('/v1/capture?')) {
        const params=new URL(request.url, 'http://localhost').searchParams;
        const url=params.get('url'); if(!url || url.length>8000)throw Error('Invalid URL.');
        result = library.lookupCapture(url,params.get('operationId'),params.get('digest'));
      }
      else if (request.method === 'POST' && request.url === '/v1/capture') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw Error('Use a JSON request.');
        let size=0, chunks=[];
        for await (const chunk of request) { size+=chunk.length; if(size>1_000_000) throw Error('Page capture is too large.'); chunks.push(chunk); }
        result = library.saveCapture(Buffer.concat(chunks).toString('utf8'));
      }
      else if (request.method === 'POST' && request.url === '/v1/import') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Use a JSON request.');
        let size = 0, chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 4_000_000) throw new Error('Import exceeds 4 MB.'); chunks.push(chunk); }
        const { items } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Browser capture is web-only. No path or file access is accepted here.
        if (!Array.isArray(items) || items.some(item => !item || !['web', 'repo'].includes(item.kind))) throw new Error('Browser imports must contain web references.');
        const { items: rows, ...counts } = library.importItems(items); result = counts;
      } else if (request.method === 'PATCH' && /^\/v1\/items\/[a-z0-9_.%-]+$/i.test(request.url || '')) {
        if (!request.headers['content-type']?.startsWith('application/json')) throw Error('Use a JSON request.');
        let size=0, chunks=[];
        for await (const chunk of request) { size+=chunk.length; if(size>16_000) throw Error('Card edit is too large.');chunks.push(chunk); }
        const patch=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const keys=patch && typeof patch==='object' && !Array.isArray(patch) ? Object.keys(patch).sort().join(',') : '';
        const id=decodeURIComponent(request.url.slice('/v1/items/'.length));
        if (!/^[a-z0-9_.-]{1,120}$/i.test(id)) throw Error('Invalid reference ID.');
        if(keys==='favorite' && typeof patch.favorite==='boolean') library.setFavorite(id,patch.favorite);
        else if(keys==='tags,title' && typeof patch.title==='string' && Array.isArray(patch.tags) && patch.tags.every(tag=>typeof tag==='string')) library.editMetadata(id,patch.title,patch.tags);
        else throw Error('Only title/tags or favorite may be edited from the browser.');
        result={updated:true};
      } else if (request.method === 'DELETE' && request.url?.startsWith('/v1/items/')) result = library.remove(decodeURIComponent(request.url.slice('/v1/items/'.length)));
      else { response.writeHead(404); response.end(JSON.stringify({ error: 'Unknown library route.' })); return; }
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error.message })); }
  });
  // Other Codex conversations may already own this port. They share the same
  // database; do not close their server or fall back to a different database.
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && !closed) {
      // Another conversation owns the bridge. Take over after it exits, without
      // keeping this MCP process alive or installing a separate background app.
      retry = setTimeout(() => { if (!closed) server.listen(port, '127.0.0.1'); }, 5000); retry.unref();
    } else if (error.code !== 'EADDRINUSE') process.stderr.write(`StashDock capture bridge: ${error.message}\n`);
  });
  const nativeClose = server.close.bind(server);
  server.close = callback => {
    closed = true; clearTimeout(retry);
    if (server.listening) return nativeClose(callback);
    queueMicrotask(() => callback?.()); return server;
  };
  server.requestTimeout = 10_000; server.headersTimeout = 5000;
  server.listen(port, '127.0.0.1');
  server.unref();
  return server;
}
