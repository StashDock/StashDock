// Owns transport recovery, request generations and the live-sidebar lifecycle.
// Navigation events are hints; a bounded health check reconciles missed events.
export function createSidebarClient(api, windowId, toDraft, {live=()=>true, interval=2000, timeout=3500}={}) {
  const clientId=crypto.randomUUID();
  let stopped=false,closing=false,port,ready,connection=0,generation=0,reading=0,expected,token,snapshot;
  let callbacks,health,reconnectTimer,checking=false;
  let saveAttempt;
  let hiddenNavigation=false;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const bounded=(promise,label,limit=timeout)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`${label} timed out.`)),limit);
    Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
  function connect() {
    if(stopped||closing)return;
    clearTimeout(reconnectTimer);
    const id=++connection,previous=port;
    port=undefined;previous?.disconnect();
    const next=api.runtime.connect({name:`stashdock-sidebar:${windowId}:${clientId}`});port=next;
    ready=new Promise((resolve,reject)=>{
      next.onMessage.addListener(message=>{
        if(id!==connection||stopped)return;
        if(message.ready){resolve();if(id>1&&!reading&&live())callbacks?.refresh(true);}
        if(message.closed||message.reset){
          reject(Error('The sidebar connection changed.'));
          // Native close notifications may refer to a transient/replaced panel.
          // The DOM's unload, not an old worker message, owns permanent disposal.
          next.disconnect();
        }
      });
      next.onDisconnect.addListener(()=>{
        if(id!==connection||stopped||closing)return;
        port=undefined;reject(Error('The sidebar connection changed.'));
        clearTimeout(reconnectTimer);
        reconnectTimer=setTimeout(()=>{if(!port&&live())try{connect();}catch{/* Health reconciliation retries later. */}},200);
      });
    });
    void ready.catch(()=>{});
  }
  async function request(type,extra={},retry=true) {
    for(let attempt=0;attempt<(retry?3:1);attempt++){
      if(stopped||closing&&type!=='close-panel')throw Error('The sidebar was closed.');
      let attemptedConnection;
      try{
        if(!port)connect();
        attemptedConnection=connection;
        await bounded(ready,'Sidebar connection');
        const result=await bounded(api.runtime.sendMessage({type,windowId,clientId,token,...extra}),'Page request',type==='save-current-page'?30000:type==='provider-status'||type==='read-tags'?16000:timeout);
        if(!result||typeof result!=='object')throw Error('The sidebar connection returned no response.');
        if(result?.error)throw Error(result.error);
        return result;
      }catch(error){
        if(!retry||attempt===2||!/connection|timed out|receiving end|port|sidebar was closed/i.test(error.message))throw error;
        // Concurrent reads can fail on the same old worker. Reuse a replacement
        // another read already opened instead of disconnecting that healthy port.
        if(!port||attemptedConnection===connection)try{connect();}catch{/* Retry remains bounded. */}
        await sleep(100*(attempt+1));
      }
    }
  }
  const key=entry=>`${entry?.token}:${entry?.revision||0}:${Boolean(entry?.loading)}:${entry?.error||''}`;
  function reconcile(entry) {
    if(!entry||stopped||closing||!live()||reading)return;
    if(key(entry)===snapshot)return;
    const same=token===entry.token;
    token=entry.token;expected=entry.expected;
    if(same&&!entry.loading&&entry.page&&!entry.error){snapshot=key(entry);callbacks?.update(toDraft(entry));}
    else callbacks?.refresh();
  }
  async function capture({force=false}={}) {
    const id=++generation;reading=id;
    const current=()=>id===generation&&!stopped&&!closing;
    try{
      let entry=await request(force?'retry-current-page':'read-current-page');
      const deadline=Date.now()+30000;
      while(entry?.loading&&current()&&Date.now()<deadline){await sleep(120);if(current())entry=await request('read-current-page');}
      if(!current())throw Error('A newer page is being read.');
      token=entry.token;expected=entry.expected;snapshot=key(entry);
      if(entry.loading)throw Error('Reading timed out. Retry reading the current page.');
      if(entry.error)throw Error(entry.error);
      return toDraft(entry);
    }finally{if(reading===id)reading=0;}
  }
  function subscribe(refresh,navigate,update) {
    callbacks={refresh,navigate,update};
    const changed=(changes,area)=>{if(area==='session')reconcile(changes[`stashdock-sidepanel:${windowId}`]?.newValue);};
    const activated=info=>{if(closing||info.windowId!==windowId||info.tabId===expected?.tabId)return;if(!live()){hiddenNavigation=true;return;}navigate();};
    const updated=(_id,change,tab)=>{if(closing||tab.windowId!==windowId||!tab.active)return;if(!live()){if(change.status==='loading'||change.url)hiddenNavigation=true;return;}if(change.status==='loading'||change.url&&change.url!==expected?.url)navigate();else if(change.status==='complete'&&!reading)refresh();};
    api.storage.onChanged.addListener(changed);api.tabs.onActivated.addListener(activated);api.tabs.onUpdated.addListener(updated);
    health=setInterval(async()=>{
      if(stopped||closing||checking||reading||!live())return;
      if(hiddenNavigation){hiddenNavigation=false;navigate();return;}
      checking=true;
      try{reconcile(await request('read-current-page'));}catch{/* A failed check is retried next tick; no poisoned UI state. */}
      finally{checking=false;}
    },interval);
    return()=>{clearInterval(health);callbacks=undefined;api.storage.onChanged.removeListener(changed);api.tabs.onActivated.removeListener(activated);api.tabs.onUpdated.removeListener(updated);};
  }
  function dispose(){stopped=true;generation++;connection++;clearInterval(health);clearTimeout(reconnectTimer);port?.disconnect();port=undefined;}
  async function close(){generation++;const operation=request('close-panel',{},false);closing=true;try{await operation;}finally{dispose();}}
  function wake(){if(stopped||closing||!live())return;if(hiddenNavigation){hiddenNavigation=false;callbacks?.navigate();}else if(!reading)callbacks?.refresh();}
  return {capture,subscribe,dispose,close,wake,providerStatus:()=>request('provider-status'),tags:async()=>(await request('read-tags')).tags||[],save:async (item,replace)=>{
    const fingerprint=JSON.stringify([item,replace]);
    if(saveAttempt?.fingerprint!==fingerprint)saveAttempt={fingerprint,operationId:crypto.randomUUID()};
    const result=await request('save-current-page',{item,operationId:saveAttempt.operationId,...(replace?{replace}:{})},false);
    if(!result?.saved&&!result?.duplicate)throw Error('The page could not be saved. Retry.');
    return result;
  }};
}
