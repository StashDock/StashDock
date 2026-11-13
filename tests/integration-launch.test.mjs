import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { integrationDestination, openIntegration, githubRepositoryUrl } from '../plugins/stashdock/server/open-integration.mjs';
import { startCaptureBridge } from '../plugins/stashdock/server/capture-bridge.mjs';

test('application opening prefers registered clients and otherwise official sites, not installation status', async () => {
  const readRegistry = async key => key === 'HKCR\\codex\\shell\\open\\command' ? 'Registered native handler' : null;
  assert.equal((await integrationDestination('codex', { platform:'win32', readRegistry })).target, 'codex://');
  assert.equal((await integrationDestination('claude', { platform:'win32', readRegistry })).target, 'https://claude.ai/');
  assert.equal((await integrationDestination('codex', { platform:'linux' })).target, 'https://chatgpt.com/');
  assert.equal((await integrationDestination('dsh', { platform:'win32', readRegistry: async key => key === 'HKCR\\dsh\\shell\\open\\command' ? 'Registered DSH' : null })).target, 'dsh://open');
  assert.equal((await integrationDestination('dsh', { platform:'win32', readRegistry: async () => null })).target, 'https://deepseek.com/harness');
  assert.deepEqual(await integrationDestination('dsh', { platform:'darwin', macApplication: async id => id === 'dsh' ? '/Applications/DeepSeek Harness.app' : null }), { target:'/Applications/DeepSeek Harness.app', fallback:null });
  const chrome = await integrationDestination('chrome', { platform:'win32', readRegistry:async key=>key.startsWith('HKCU')?'(Default) REG_SZ C:\\Chrome\\chrome.exe':null, file:()=>true });
  assert.equal(chrome.target, 'C:\\Chrome\\chrome.exe');
  assert.equal((await integrationDestination('desktop', { platform:'win32', desktopPath:'D:\\StashDock\\stashdock.exe', file:()=>true })).target,'D:\\StashDock\\stashdock.exe');
  for (const id of ['__proto__','file:///private','../codex','powershell']) await assert.rejects(integrationDestination(id), /supported/);
  assert.equal((await integrationDestination('desktop', {platform:'win32',desktopPath:'D:\\other.exe',file:()=>true,readRegistry:async()=>null})).target, 'https://stashdock.app/guide#install-desktop');
});
test('launches use OS shell dispatch without shell strings or ownership of the opened app', async () => {
  const calls=[];
  await openIntegration('claude',{platform:'win32',readRegistry:async()=>null,launch:(command,args,options)=>{
    calls.push({command,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  }});
  assert.deepEqual(calls[0].args,['url.dll,FileProtocolHandler','https://claude.ai/']);
  assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.detached,true);
  assert.equal(githubRepositoryUrl(null),null);assert.equal(githubRepositoryUrl('../bad'),null);assert.equal(githubRepositoryUrl('https://evil.test/path'),null);
  assert.equal(githubRepositoryUrl('example/stashdock'),'https://github.com/example/stashdock');
});
test('browser app opening is limited to trusted extension requests and fixed IDs', async t => {
  const origin='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const calls=[];const server=startCaptureBridge({browserOriginAllowed:value=>value===origin},0,{openApp:async id=>{calls.push(id);return {opened:true};}});
  await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/v1/open-integration`;
  const headers={'content-type':'application/json','x-stashdock-client':'chrome-extension-v1',origin};
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({id:'claude'})})).status,200);
  assert.deepEqual(calls,['claude']);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,origin:'https://evil.test'},body:'{"id":"claude"}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{"id":"file:///private"}'})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{"id":"claude","url":"https://evil.test"}'})).status,400);
  assert.deepEqual(calls,['claude']);
});

 test('Mac integrations resolve native clients first and never hide their failure with a website', async () => {
  const calls=[];
  const macApplication=async (id,path)=>{calls.push([id,path]);return id==='chrome'?'/Applications/Google Chrome.app':null;};
  assert.deepEqual(await integrationDestination('chrome',{platform:'darwin',macApplication}),{target:'/Applications/Google Chrome.app',fallback:null});
  assert.equal((await integrationDestination('claude',{platform:'darwin',macApplication})).target,'https://claude.ai/');
  await assert.rejects(integrationDestination('../arbitrary',{platform:'darwin',macApplication}),/supported/);
  assert.deepEqual(calls,[['chrome',undefined],['claude',undefined]]);
});


test('Mac Safari opens its registered system application', async () => {
  const calls = [];
  const destination = await integrationDestination('safari', { platform:'darwin', macApplication: async id => { calls.push(id); return '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app'; } });
  assert.deepEqual(calls, ['safari']);
  assert.ok(destination.target.endsWith('/Safari.app'));
  assert.equal(destination.fallback, null);
});
