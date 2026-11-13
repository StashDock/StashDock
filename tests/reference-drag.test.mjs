import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const read=file=>readFile(new URL('../'+file,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const transport={native:false,invoke:async()=>({dropped:true,status:'dropped'})};
globalThis.__referenceTransport=transport;
const apiUrl=moduleUrl('export const isTauri=()=>globalThis.__referenceTransport.native; export const invoke=(...args)=>globalThis.__referenceTransport.invoke(...args);');
const contextUrl=moduleUrl(compile(await read('src/lib/context.ts')).replaceAll("'./context-format.mjs'", JSON.stringify(new URL('../src/lib/context-format.mjs', import.meta.url).href)).replace("'@tauri-apps/api/core'",JSON.stringify(apiUrl)));
const nativeUrl=moduleUrl(compile(await read('src/lib/reference-drag-native.ts')).replace('"@tauri-apps/api/core"',JSON.stringify(apiUrl)));
const nativeDrag=await import(nativeUrl);
const source=compile(await read('src/lib/reference-drag.ts')).replace('"./context-format.mjs"',JSON.stringify(new URL('../src/lib/context-format.mjs', import.meta.url).href)).replace('"./context"',JSON.stringify(contextUrl)).replace('"./reference-drag-native"',JSON.stringify(nativeUrl)).replace('"@tauri-apps/api/core"',JSON.stringify(apiUrl));
const drag=await import(moduleUrl(source));
const item={id:'1',title:'Title <script> & "quoted"',kind:'web',source:'fixture.test',url:'https://fixture.test',excerpt:'资料 🌟',tags:[]};

test('browser drag retains escaped public text formats; Copy for AI remains separate',()=>{
  const payload=drag.referenceDragPayload([item]);
  assert.equal(payload['text/plain'],payload['text/markdown']);
  assert.match(payload['text/html'],/&lt;script&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(payload['text/html'],/<script>|<img/);
  assert.equal(payload['text/uri-list'],item.url);
  const batch=drag.referenceDragPayload([item,{...item,kind:'note',title:'Local note',url:undefined}]);
  assert.match(batch['text/plain'],/Local note/);
  assert.equal(batch['text/uri-list'],'');
});

test('download metadata preserves Unicode context and flat Unicode-safe filenames',()=>{
  const context=drag.referenceDragPayload([item])['text/markdown'];
  const metadata=drag.referenceDownloadPayload(context,'../资料: "test" / item',1);
  const fields=metadata.split(':');
  assert.doesNotMatch(fields[1],/[<>:"/\\|?*\u0000-\u001f]/);
  assert.match(fields[1],/\.md$/);
  assert.equal(decodeURIComponent(metadata.slice(metadata.indexOf(',')+1)),context);
  assert.equal(drag.referenceFileName('a'.repeat(63)+'🌟',1),'StashDock - '+'a'.repeat(63)+'🌟.md');
  assert.equal(drag.referenceFileName('... ',1),'StashDock - Reference.md');
  assert.match(drag.referenceDownloadPayload(context,'ignored',2),/:StashDock - Selected references\.md:/);
});

test('native transport is local Tauri IPC with IDs and raster, never HTTP, fake paths or private host APIs',async()=>{
  const calls=[];transport.native=true;transport.invoke=async(...args)=>{calls.push(args);return {dropped:true,status:'dropped'};};
  try {
    assert.equal(await nativeDrag.dragReferenceFile(['a','b'],'png'),true);
    assert.deepEqual(calls,[['drag_reference_file',{itemIds:['a','b'],preview:'png'}]]);
    const source=await read('src/lib/reference-drag-native.ts');
    assert.doesNotMatch(source,/fetch|clipboard|electronBridge|setInterval|pointermove|mousemove|configureNativeReferenceDrag/);
  } finally {transport.native=false;}
});

test('browser surfaces cannot invoke native file drag',async()=>{
  transport.native=false;
  transport.invoke=async()=>{throw Error('Browser must not invoke');};
  await assert.rejects(nativeDrag.dragReferenceFile(['a'],'png'),/desktop window/);
});

test('native rejection, late release and IPC errors never fall back to pasted text; cancellation is quiet',async()=>{
  transport.native=true;
  try {
    for(const [status,message] of [['rejected',/target did not accept/],['released-before-start',/Hold the card/],['unknown',/not dropped/]]) {
      transport.invoke=async()=>({dropped:false,status});
      await assert.rejects(nativeDrag.dragReferenceFile(['a'],'png'),message);
    }
    transport.invoke=async()=>({dropped:false,status:'cancelled'});
    assert.equal(await nativeDrag.dragReferenceFile(['a'],'png'),false);
    transport.invoke=async()=>{throw Error('Native failure');};
    await assert.rejects(nativeDrag.dragReferenceFile(['a'],'png'),/Native failure/);
  } finally {transport.native=false;}
});

test('native card gesture carries no browser text, guards duplicate start and clears its lift after completion',async()=>{
  const saved=new Map(['window','document','Element','getComputedStyle'].map(key=>[key,globalThis[key]]));
  let resolveDrop;const calls=[];let prevented=0;
  const painter={fillStyle:'',strokeStyle:'',font:'',beginPath(){},roundRect(){},fill(){},stroke(){},fillText(){},measureText(text){return {width:text.length*5};}};
  const source={dataset:{},isConnected:true,getAttribute(){return null;},querySelector(){return null;},getBoundingClientRect(){return {left:0,top:0};}};
  const event={target:{},currentTarget:source,clientX:20,clientY:20,preventDefault(){prevented++;},dataTransfer:{items:{clear(){throw Error('Native must not write browser data');}}}};
  globalThis.window={dispatchEvent(){}};globalThis.Element=class {};
  globalThis.document={createElement(){return {getContext(){return painter;},toDataURL(){return 'data:image/png;base64,test';}};},querySelectorAll(){return [];}};
  globalThis.getComputedStyle=()=>({fontFamily:'Inter',getPropertyValue(){return '14px';}});
  transport.native=true;transport.invoke=(...args)=>{calls.push(args);return new Promise(resolve=>{resolveDrop=resolve;});};
  try {
    drag.startReferenceDrag(event,[item]);drag.startReferenceDrag(event,[item]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(prevented,2);assert.equal(calls.length,1);assert.equal(source.dataset.dragging,'true');
    assert.deepEqual(calls[0],['drag_reference_file',{itemIds:['1'],preview:'data:image/png;base64,test'}]);
    resolveDrop({dropped:true,status:'dropped'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(source.dataset.dragging,undefined);
  } finally {transport.native=false;for(const [key,value] of saved)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('all card forms share transport and cleanup; controls are not drag handles',async()=>{
  for(const file of ['StashCard','ContextBar']) {
    const surface=await read(`src/components/${file}.tsx`);
    assert.match(surface,/startReferenceDrag\(event,/);
    assert.match(surface,/onDragEnd(?:=\{endReferenceDrag\}|: endReferenceDrag)/);
    assert.doesNotMatch(surface,/dataTransfer\.setData/);
  }
  const source=await read('src/lib/reference-drag.ts');
  for(const pattern of [/setDragImage/,/document\.body\.append\(canvas\)/,/canvas\.getBoundingClientRect\(\)/,/painter\.drawImage\(thumbnail/,/closest\("button, a, input, textarea"\)/,/removeEventListener\("dragend"/])assert.match(source,pattern);
  assert.doesNotMatch(source,/fetch\(|electronBridge|setInterval|pointermove|mousemove|attachmentTrial|referenceDragFile/);
});

test('native command owns its source; the retired HTTP broker cannot enter an OLE loop',async()=>{
  const native=await read('src-tauri/src/reference_drag.rs');
  assert.match(native,/!matches!\(window.label\(\), "main" \| "search"\)/);
  assert.match(native,/spawn_blocking/);
  assert.match(native,/if !owns_foreground_input\(\)/);
  assert.match(native,/GetForegroundWindow/);
  assert.doesNotMatch(native,/pub fn capability|pub fn diagnostics/);
  const bridge=await read('src-tauri/src/library/bridge.rs');
  assert.doesNotMatch(bridge,/reference_drag::start\(/);
  assert.doesNotMatch(bridge,/\/v1\/drag|DockAssets|dock-ui-v1/);
  assert.match(await read('src-tauri/src/lib.rs'),/reference_drag::drag_reference_file/);
});

test('screenshots and favicons cannot trigger the host image-drag path',async()=>{
  for(const file of ['StashCard','SiteIdentity'])assert.match(await read(`src/components/${file}.module.css`),/\.\w+(?: img)? \{[^}]*pointer-events: none/);
});

test('native Shell data carries a real file with alpha preview; no input injection or host IPC',async()=>{
  const source=await read('src-tauri/src/reference_drag_windows.rs');
  for(const pattern of [/CF_HDROP/,/DragQueryFileW/,/CreateDIBSection/,/DeleteObject/,/OleUninitialize/,/effect & DROPEFFECT_COPY/])assert.match(source,pattern);
  assert.doesNotMatch(source,/SendInput|AttachThreadInput|SetForegroundWindow|SetClipboardData|mouse_event/);
});
