// Real Windows executable + real SQLite, isolated from the user's library and
// registry. No Desktop, MCP server, localhost bridge or logged-in browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, mkdtempSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createNativeClient } from '../extension/native-client.js';
import { createBrowserLibrary } from '../extension/library-client.js';
import { createLocalLibrary } from '../plugins/stashdock/server/local-library.mjs';
import productLinks from '../src-tauri/product-links.json' with { type: 'json' };

const executable = resolve('src-tauri/target/release/stashdock-browser'+(process.platform==='win32'?'.exe':''));
const manifest=JSON.parse(readFileSync('extension/manifest.json'));
const chromium=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const firefox=JSON.parse(readFileSync('src-tauri/product-links.json')).browserExtensions.firefox.id;
const supported=['win32','darwin'].includes(process.platform)&&existsSync(executable);

test('packaged native helper accepts both store IDs and exact upgrade callers, rejecting unrelated origins', {skip:!supported&&'Build the native helper first'}, t=>{
  const fixture=realpathSync(mkdtempSync(join(tmpdir(),'stashdock-store-callers-')));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const env={...process.env,HOME:fixture,APPDATA:fixture,LOCALAPPDATA:fixture,PATH:'',STASHDOCK_NATIVE_HOST_REGISTRATION:'off'};
  delete env.STASHDOCK_DATA_DIR;
  const ids=[...new Set(['chrome','edge'].flatMap(browser=>[productLinks.browserExtensions[browser].id,...productLinks.browserExtensions[browser].legacyIds]))];
  const request=Buffer.from(JSON.stringify({path:'/health'})),size=Buffer.alloc(4);size.writeUInt32LE(request.length);
  for(const id of [...ids,'a'.repeat(32)]){
    const response=spawnSync(executable,[`chrome-extension://${id}/`],{env,cwd:fixture,windowsHide:true,input:Buffer.concat([size,request]),timeout:15000});
    assert.ifError(response.error);
    if(!ids.includes(id)){assert.notEqual(response.status,0);assert.equal(response.stdout.length,0);continue;}
    assert.equal(response.status,0,response.stderr?.toString());
    assert.equal(response.stdout.readUInt32LE(0),response.stdout.length-4);
    const message=JSON.parse(response.stdout.subarray(4));
    assert.equal(message.ok,true,JSON.stringify(message));assert.equal(message.value.ok,true);
  }
});

test('relocated native helpers use a fresh user default library without developer paths or PATH', {skip:!supported&&'Build the native helper first'}, async t=>{
  const fixture=realpathSync(mkdtempSync(join(tmpdir(),'stashdock-portability-')));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const profile=join(fixture,'用户 Profile','Roaming');
  const env={...process.env,HOME:profile,APPDATA:profile,LOCALAPPDATA:join(fixture,'用户 Profile','Local'),PATH:'',STASHDOCK_NATIVE_HOST_REGISTRATION:'off'};
  delete env.STASHDOCK_DATA_DIR;
  const helpers=['Desktop 安装','Plugin 安装'].map(folder=>{
    const target=join(fixture,folder,'stashdock-browser'+(process.platform==='win32'?'.exe':''));
    mkdirSync(join(fixture,folder),{recursive:true});cpSync(executable,target);return target;
  });
  function request(helper,path,body){
    const bytes=Buffer.from(JSON.stringify({path,...(body?{body:JSON.stringify(body)}:{})})),size=Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    const result=spawnSync(helper,[`chrome-extension://${chromium}/`],{env,cwd:fixture,windowsHide:true,input:Buffer.concat([size,bytes]),timeout:15000});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr?.toString());
    assert.ok(result.stdout.length>=4);assert.equal(result.stdout.readUInt32LE(0),result.stdout.length-4);
    const response=JSON.parse(result.stdout.subarray(4));assert.equal(response.ok,true,JSON.stringify(response));return response.value;
  }
  for(const [index,helper] of helpers.entries()){
    assert.equal(request(helper,'/health').ok,true);
    assert.equal(request(helper,'/capture',{operationId:randomUUID(),item:{id:'draft',kind:'web',title:`Portable ${index}`,source:'Example',url:`https://example.org/portable-${index}`,content:'Fresh-user capture',excerpt:'Context',tags:['Portable'],createdAt:new Date().toISOString(),favorite:false}}).saved,true);
  }
  const root=join(profile,...(process.platform==='darwin'?['Library','Application Support']:[]),'app.stashdock.desktop');
  assert.equal(JSON.parse(readFileSync(join(root,'library-root-v1.json'),'utf8')).anchor,root);
  const db=new DatabaseSync(join(root,'stashdock.sqlite3'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stash_items').get().n,2);}finally{db.close();}
  // A separate Node process resolves the same default library, without passing
  // dataDir or loading the MCP startup module that registers real HKCU hosts.
  const module=pathToFileURL(resolve('plugins/stashdock/server/local-library.mjs')).href;
  const code=`import {createLocalLibrary} from ${JSON.stringify(module)}; const library=createLocalLibrary(); try {console.log(JSON.stringify((await library.read()).map(item=>item.title).sort()));} finally {library.close();}`;
  const node=spawnSync(process.execPath,['--input-type=module','--eval',code],{env,cwd:fixture,windowsHide:true,encoding:'utf8',timeout:15000});
  assert.ifError(node.error);assert.equal(node.status,0,node.stderr);assert.deepEqual(JSON.parse(node.stdout),['Portable 0','Portable 1']);
  // Test registration path resolution after relocation without touching HKCU.
  const registration=join(fixture,'Plugin 安装','scripts','register-browser-host.mjs');
  mkdirSync(join(fixture,'Plugin 安装','scripts'));
  cpSync(resolve('plugins/stashdock/scripts/register-browser-host.mjs'),registration);
  const {registerBrowserHost}=await import(pathToFileURL(registration));
  const calls=[];await registerBrowserHost({ env: {}, platform: 'win32', run: (...args)=>calls.push(args) });
  assert.equal(calls[0][0],resolve(fixture,'Plugin 安装',`bin/win32-x64/stashdock-browser.exe`));
  assert.deepEqual(calls[0][1],['--register','plugin']);
});

test('actual native host saves with both apps absent, shares receipts/index/location with Node and exits after every request', {skip:!supported&&'Build the native helper first'}, async t=>{
  const fixture=realpathSync(mkdtempSync(join(tmpdir(),'stashdock-browser-native-')));
  const dataDir=join(fixture,'library'), children=[];
  const env={...process.env,HOME:join(fixture,'profile'),APPDATA:join(fixture,'profile'),STASHDOCK_DATA_DIR:dataDir,STASHDOCK_NATIVE_HOST_REGISTRATION:'off'};
  t.after(async()=>{await Promise.all(children);rmSync(fixture,{recursive:true,force:true});});
  function runtime(browser,pluginOnly=false){
    const api={lastError:undefined};
    api.connectNative=host=>{
      const listeners=[],disconnects=[];let child,responded=false;
      return {onMessage:{addListener:f=>listeners.push(f)},onDisconnect:{addListener:f=>disconnects.push(f)},disconnect(){child?.stdin.end();},postMessage(request){
        if(pluginOnly&&host.endsWith('.desktop')){queueMicrotask(()=>{api.lastError={message:'Specified native messaging host not found.'};disconnects.forEach(f=>f());api.lastError=undefined;});return;}
        child=spawn(executable,browser==='firefox'?['host.json',firefox]:[`chrome-extension://${chromium}/`],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
        children.push(once(child,'close'));
        const bytes=Buffer.from(JSON.stringify(request)),size=Buffer.alloc(4);size.writeUInt32LE(bytes.length);
        let output=Buffer.alloc(0),errors='';
        child.stderr.on('data',v=>{errors+=v;});
        child.stdout.on('data',v=>{output=Buffer.concat([output,v]);if(!responded&&output.length>=4&&output.length===output.readUInt32LE(0)+4){responded=true;listeners.forEach(f=>f(JSON.parse(output.subarray(4))));}});
        child.on('close',code=>{if(!responded){api.lastError={message:`Native host exited (${code}): ${errors}`};disconnects.forEach(f=>f());api.lastError=undefined;}});
        child.stdin.end(Buffer.concat([size,bytes]));
      }};
    };
    return api;
  }
  let saved;
  for(const browser of ['chrome','edge','firefox']){
    const native=createNativeClient(runtime(browser,browser==='edge'));
    assert.equal((await native.query('/setup',JSON.stringify({browser,version:manifest.version,extensionId:browser==='firefox'?firefox:chromium}))).value.connected,true);
    const client=createBrowserLibrary({native,storage:{get:async()=>({}),set:async()=>{}},fetcher:()=>{throw Error('Neither app is running; HTTP must not be called');}});
    const item={id:'draft',title:`Native ${browser}`,kind:'web',source:'Example',url:`https://example.org/native-${browser}`,content:'Context saved without either application running.',excerpt:'Context',tags:['Native'],createdAt:new Date().toISOString(),favorite:false};
    const operationId=randomUUID();
    const result=await client.save(item,{operationId});assert.equal(result.saved,true);
    assert.deepEqual(await client.save(item,{operationId}),result,'same receipt prevents a second mutation after a lost response');
    assert.equal((await client.save({...item,title:'Changed'},{operationId:randomUUID()})).duplicate.id,result.id);
    assert.deepEqual(await client.tags(),['Native']);
    saved={native,client,item,result};
  }
  const library=createLocalLibrary({dataDir});
  assert.equal((await library.read()).length,3);
  assert.equal(library.searchIds('application').length,3,'native saves update the shared full-text index');
  const monitor=new DatabaseSync(join(dataDir,'stashdock.sqlite3'));
  const version=()=>monitor.prepare('PRAGMA data_version').get().data_version;
  const before=version();
  await saved.native.query('/health');await saved.native.query('/health');
  assert.equal(version(),before,'health checks must not write the library');monitor.close();
  const original=(await library.read()).find(i=>i.id===saved.result.id);
  library.setFavorite(original.id,true);library.editContext(original.id,'Keep my AI instructions');
  const duplicate=(await saved.client.save(saved.item,{operationId:randomUUID()})).duplicate;
  assert.equal((await saved.client.save({...saved.item,content:'Replaced text'},{operationId:randomUUID(),replace:duplicate})).replaced,true);
  assert.equal((await library.read()).find(i=>i.id===original.id).favorite,false);
  assert.equal((await library.read()).find(i=>i.id===original.id).contextOverride,undefined);
  assert.equal((await library.read()).find(i=>i.id===original.id).content,'Replaced text');
  library.close();
  await Promise.all(children);
  const moved=join(fixture,'moved');mkdirSync(moved);cpSync(join(dataDir,'stashdock.sqlite3'),join(moved,'stashdock.sqlite3'));
  const old=new DatabaseSync(join(dataDir,'stashdock.sqlite3'));old.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES ('library_location_v1',?)").run(moved);old.close();
  assert.deepEqual((await saved.native.query('/tags','{}')).value.tags,['Native']);
  renameSync(join(moved,'stashdock.sqlite3'),join(moved,'unavailable.sqlite3'));
  await assert.rejects(saved.native.query('/tags','{}'),/unavailable/i);
  assert.equal(existsSync(join(moved,'stashdock.sqlite3')),false,'missing registered library must never be recreated');
});
