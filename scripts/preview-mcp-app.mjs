// Development harness only. The draft below is a test fixture, NOT Codex's composer.
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
// Mac preview exercises the assembled server and its matching native helpers.
const { createServer, SHELF_URI } = await import(process.platform === 'darwin'
  ? '../output/plugin-build/darwin-arm64/plugins/stashdock/dist/mcp-server.mjs'
  : '../plugins/stashdock/server/create-server.mjs');

const htmlUrl = new URL(process.platform === 'darwin' ? '../output/plugin-build/darwin-arm64/plugins/stashdock/web/shelf.html' : '../plugins/stashdock/web/shelf.html', import.meta.url);
const importFixture = process.env.STASHDOCK_PREVIEW_IMPORT_FIXTURE === '1' && process.env.STASHDOCK_PREVIEW_MUTATIONS === '1' && process.env.STASHDOCK_DATA_DIR?.includes('mcp-test-');
const fixtureIcon = importFixture ? `data:image/png;base64,${readFileSync(new URL('../assets/brand/icon.png', import.meta.url)).toString('base64')}` : '';
const importServices = importFixture ? {
  readBrowser: async browser => {
    const profiles = await importServices.sources();
    const matching = profiles.filter(source => source.browser === browser);
    return matching.length ? { status: 'ready', bookmarks: (await Promise.all(matching.map(source => importServices.bookmarks(source.id)))).flat() } : { status: 'unavailable' };
  },
  openCaptureSite: async site => ({ opened: true, site }),
  sources: async () => { await new Promise(resolve => setTimeout(resolve, 700)); return [{ id: 'chrome:Default', browser: 'Chrome', profile: 'Personal' }, { id: 'chrome:Profile 1', browser: 'Chrome', profile: 'Work' }, { id: 'edge:Default', browser: 'Edge', profile: 'Personal' }]; },
  bookmarks: async id => id === 'chrome:Profile 1' ? [{ title: 'Other profile', url: 'https://example.org/other-profile', folderPath: ['Work'] }] : [{ title: 'Already saved', url: 'https://example.org/0', folderPath: ['Research'] }, { title: 'New browser link', url: 'https://example.org/new-bookmark', folderPath: ['Research'] }],
  icons: async urls => { await new Promise(resolve => setTimeout(resolve, 300)); return Object.fromEntries(urls.map(url => [url, fixtureIcon])); },
  preview: async url => { await new Promise(resolve => setTimeout(resolve, 300)); if (url.includes('fail')) throw new Error('This page requires access. Enter its details manually.'); return { title: 'Detected import title', content: 'Full import fixture content\n\nSecond paragraph', faviconUrl: 'https://example.org/favicon.ico' }; },
} : undefined;
const isolatedLibrary = process.env.STASHDOCK_PREVIEW_MUTATIONS === '1' && process.env.STASHDOCK_DATA_DIR?.includes('mcp-test-');
const server = createServer({ htmlUrl, ...(isolatedLibrary ? { dataDir: process.env.STASHDOCK_DATA_DIR } : {}), ...(importServices ? { importServices } : {}) });
const client = new Client({ name: 'StashDock development harness', version: '1' });
const [left, right] = InMemoryTransport.createLinkedPair();
await server.connect(left); await client.connect(right);
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>StashDock MCP App test harness</title><style>
body{margin:0;font-family:system-ui;background:#eee}header{padding:12px;background:#fff;border-bottom:1px solid #ccc}
textarea{width:100%;box-sizing:border-box;height:52px}#attachments{display:flex;gap:8px;flex-wrap:wrap;padding:8px 0}
.chip{border:1px solid #aaa;border-radius:12px;padding:8px}iframe{display:block;width:100%;height:calc(100dvh - var(--test-header-height, 140px));border:0;background:#fff}
</style></head><body><header>Development harness. This is not the Codex composer.
<label for="draft">Test draft</label><textarea id="draft">Keep this draft unchanged.</textarea><div id="attachments"></div><output id="status"></output></header>
<script>
const options=new URLSearchParams(location.search);const frame=document.createElement('iframe');frame.title='StashDock MCP App';
const requests=[];window.testRequests=requests;
addEventListener('message',async event=>{
 if(event.source!==frame.contentWindow || event.origin!==location.origin || event.data?.jsonrpc!=='2.0')return;
 const request=event.data;if(request.id===undefined)return;let result;
 try{
  if(request.method==='ui/initialize') result={protocolVersion:request.params.protocolVersion,hostInfo:{name:'Development harness',version:'1'},hostContext:{theme:options.get('theme')||'light',locale:options.get('locale')||'en-US',displayMode:options.get('mode')||'fullscreen',availableDisplayModes:['fullscreen']},hostCapabilities:{serverTools:{},serverResources:{},message:{text:{},resource:{}},experimental:options.get('draft')==='0'?{}:{'openai/message':options.get('draft')==='hint'?{draft:{}}:{}}}};
  else if(request.method==='ui/request-display-mode') {window.testModeRequest=request.params;result={mode:'fullscreen'};}
  else if(request.method==='tools/call') {const response=await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request.params)});if(!response.ok)throw Error('Test bridge failure');result=await response.json();}
  else if(request.method==='ui/message') {
   requests.push(request);if(options.get('reject')==='1')throw Error('Simulated host rejection');
   if(options.get('rejectFirst')==='1'&&requests.length===1)throw Error('The composer is unavailable');
   if(request.params._meta?.['openai/message']?.send!==false || request.params.content.some(block=>block.type!=='text' || !block._meta?.['openai/title']))throw Error('Unsafe draft payload');
   const chip=document.createElement('span');chip.className='chip';chip.textContent=request.params.content[0]._meta['openai/title'];
   const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','Remove test attachment');remove.onclick=()=>chip.remove();chip.append(remove);document.querySelector('#attachments').append(chip);
   document.querySelector('#status').textContent='Draft attachment received (test harness only)';result={};
  } else result={};
  frame.contentWindow.postMessage({jsonrpc:'2.0',id:request.id,result},location.origin);
 }catch(error){frame.contentWindow.postMessage({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:error.message}},location.origin);}
});frame.src='/shelf.html';document.body.append(frame);
new ResizeObserver(([entry])=>document.documentElement.style.setProperty('--test-header-height',entry.target.getBoundingClientRect().height+'px')).observe(document.querySelector('header'));
</script></body></html>`;

const http = createHttpServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/shelf.html') {
      const ui = (await client.readResource({ uri: SHELF_URI })).contents[0];
      const domains = ui._meta.ui.csp.resourceDomains.join(' ');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${domains}; font-src data:; connect-src 'none'`);
      response.setHeader('Content-Type', 'text/html'); response.end(ui.text); return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/')) {
      response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); return;
    }
    if (request.method === 'POST' && request.url === '/tool') {
      let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 14_000_000) throw new Error('Request too large'); }
      const input = JSON.parse(text);
      if (input.name === 'open_stashdock_integration' && isolatedLibrary) {
        if (!['chrome','edge','firefox','safari','codex','claude','desktop'].includes(input.arguments?.id)) throw Error('Invalid fixture app.');
        // Exercise the actual SDK/UI path without launching the user's real AI app.
        response.setHeader('Content-Type','application/json');response.end(JSON.stringify({content:[{type:'text',text:'{"opened":true}'}],structuredContent:{opened:true}}));return;
      }
      const readTools = ['read_stashdock_browser_import', 'get_stashdock_integrations', 'get_stashdock_settings', 'get_stashdock_storage_info', 'list_stashdock_shelf', 'select_stashdock_shelf', 'prepare_stashdock_attachment', 'prepare_stashdock_cover', 'get_stashdock_context', 'list_stashdock_import_sources', 'read_stashdock_browser_bookmarks', 'read_stashdock_bookmark_icons', 'preview_stashdock_link','list_stashdock_capture_platforms'];
      const writeTools = ['open_stashdock_storage_folder', 'choose_stashdock_storage_location', 'move_stashdock_storage', 'save_stashdock_preferences', 'import_stashdock_references', 'import_stashdock_files', 'set_stashdock_favorite', 'set_stashdock_tags', 'edit_stashdock_reference', 'edit_stashdock_context', 'rename_stashdock_tag', 'delete_stashdock_tag', 'delete_stashdock_reference','open_stashdock_capture_site','save_stashdock_capture_platform'];
      // Test mutations must never target the actual user's collection.
      readTools.push('search_stashdock', 'list_stashdock_tags', 'get_stashdock_items', 'get_stashdock_file');
      writeTools.push('save_stashdock_reference', 'delete_stashdock_references', 'set_stashdock_sort', 'record_stashdock_use');
      const isolated = process.env.STASHDOCK_PREVIEW_MUTATIONS === '1' && process.env.STASHDOCK_DATA_DIR?.includes('mcp-test-');
      if (!readTools.includes(input.name) && !(isolated && writeTools.includes(input.name))) throw new Error('Tool not allowed in test harness');
      const result = await client.callTool(input, undefined, { timeout: input.name === 'choose_stashdock_storage_location' ? 300_000 : input.name === 'move_stashdock_storage' ? 660_000 : 60_000 });
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return;
    }
    response.writeHead(404); response.end();
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
});
const port = Number(process.env.STASHDOCK_PREVIEW_PORT || 18747);
http.listen(port, '127.0.0.1', () => console.log('MCP App development harness: http://127.0.0.1:' + port));
async function close() { http.close(); await client.close(); await server.close(); }
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
