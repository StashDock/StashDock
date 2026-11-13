import test from 'node:test';
import assert from 'node:assert/strict';
import {createSidebarClient} from '../extension/sidebar-client.js';
function event(){const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>{for(const fn of [...listeners])fn(...args);}};}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
  const ports=[],calls=[];let entry={token:'a',revision:0,expected:{tabId:1,url:'https://one.example'},page:{content:'First body'}};
  const api={storage:{onChanged:event()},tabs:{onActivated:event(),onUpdated:event()},runtime:{connect(){const port={onMessage:event(),onDisconnect:event(),disconnect(){port.onDisconnect.emit();}};ports.push(port);queueMicrotask(()=>port.onMessage.emit({ready:true}));return port;},async sendMessage(message){calls.push(message.type);return message.type==='save-current-page'?{saved:true}:structuredClone(entry);}}};
  const client=createSidebarClient(api,2,value=>value.page,{interval:15,timeout:40});
  return {client,api,calls,ports,get entry(){return entry;},set entry(value){entry=value;}};
}
test('a reset or lost port recovers while the same sidebar stays open',async()=>{
  const f=fixture();let refreshes=0;
  const unsubscribe=f.client.subscribe(()=>{refreshes++;},()=>{},()=>{});
  try{await f.client.capture();f.ports[0].onMessage.emit({reset:true});await delay(240);assert.ok(f.ports.length>=2);assert.ok(refreshes>=1);assert.equal((await f.client.capture()).content,'First body');}
  finally{unsubscribe();f.client.dispose();}
});

test('parallel reads share one recovery and a delayed reconnect never replaces the healthy port',async()=>{
  const f=fixture();const previous=f.api.runtime.sendMessage;const failures=[];
  f.api.runtime.sendMessage=message=>{
    if(failures.length<3)return new Promise((_resolve,reject)=>{
      failures.push(reject);
      if(failures.length===3)queueMicrotask(()=>{
        f.ports[0].disconnect();
        failures.forEach(fail=>fail(Error('The sidebar connection changed.')));
      });
    });
    if(message.type==='provider-status')return Promise.resolve({connected:true});
    if(message.type==='read-tags')return Promise.resolve({tags:[]});
    return previous(message);
  };
  try{
    const [page,status,tags]=await Promise.all([f.client.capture(),f.client.providerStatus(),f.client.tags()]);
    assert.equal(page.content,'First body');assert.equal(status.connected,true);assert.deepEqual(tags,[]);
    await delay(240);
    assert.equal(f.ports.length,2,'Only one replacement connection should be opened');
    assert.equal((await f.client.capture()).content,'First body');
  }finally{f.client.dispose();}
});
test('health reconciliation detects a missed navigation event, then stops after disposal',async()=>{
  const f=fixture();let refreshes=0;const unsubscribe=f.client.subscribe(()=>{refreshes++;},()=>{},()=>{});
  try{await f.client.capture();f.entry={...f.entry,token:'b',expected:{tabId:2,url:'https://two.example'},page:{content:'New body'}};await delay(45);assert.ok(refreshes>0);f.client.dispose();const n=f.calls.length;await delay(45);assert.equal(f.calls.length,n);}
  finally{unsubscribe();f.client.dispose();}
});
test('content revisions update in place instead of restarting capture, and Save is never replayed after timeout',async()=>{
  const f=fixture();let updated;const unsubscribe=f.client.subscribe(()=>{},()=>{},page=>{updated=page;});
  try{await f.client.capture();f.entry={...f.entry,revision:1,page:{content:'Full body'}};f.api.storage.onChanged.emit({'stashdock-sidepanel:2':{newValue:f.entry}},'session');assert.equal(updated.content,'Full body');
    const previous=f.api.runtime.sendMessage;let saves=0;f.api.runtime.sendMessage=async message=>{if(message.type==='save-current-page'){saves++;return new Promise(()=>{});}return previous(message);};await assert.rejects(f.client.save({}),/timed out/);assert.equal(saves,1);
  }finally{unsubscribe();f.client.dispose();}
});
test('out-of-order responses do not poison the newest page identity',async()=>{
  const f=fixture();let release;let reads=0;f.api.runtime.sendMessage=async()=>++reads===1?new Promise(resolve=>{release=()=>resolve(f.entry);}):{token:'new',expected:{tabId:2,url:'https://two.example'},page:{content:'Latest body'}};
  try{const first=f.client.capture().catch(()=>null);await delay(0);const latest=await f.client.capture({force:true});release();await first;assert.equal(latest.content,'Latest body');}
  finally{f.client.dispose();}
});
test('hidden navigation is recorded without reading and refreshed on visibility restoration',async()=>{
  const f=fixture();let visible=false,navigations=0;const client=createSidebarClient(f.api,2,value=>value.page,{live:()=>visible,interval:15,timeout:40});
  const unsubscribe=client.subscribe(()=>{},()=>{navigations++;},()=>{});
  try{f.api.tabs.onActivated.emit({windowId:2,tabId:3});await delay(40);assert.equal(f.calls.length,0);visible=true;client.wake();assert.equal(navigations,1);}
  finally{unsubscribe();client.dispose();f.client.dispose();}
});
