const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const metadata=fs.readFileSync(path.join(__dirname, '..','metadata.js'),'utf8');
const background=fs.readFileSync(path.join(__dirname, '..','background.js'),'utf8');
let now=Date.now();
function worker(seed={}) {
  let saved=structuredClone(seed),listener,calls=0;
  const sandbox={URL,AbortController,Promise,Date:class extends Date {static now(){return now;}},clearTimeout(){},
    setTimeout(callback,delay){if(delay!==10000){now+=delay;queueMicrotask(callback);}return 1;},
    chrome:{storage:{local:{get:async()=>structuredClone(saved),set:async value=>{saved=structuredClone(value);}}},
      runtime:{id:'fixture',getURL:file=>'chrome-extension://fixture/'+file,onMessage:{addListener:callback=>{listener=callback;}}}},
    fetch:async()=>{calls++;throw new Error('Unexpected network request');}};
  const context=vm.createContext(sandbox);
  context.importScripts=()=>vm.runInContext(metadata,context);
  vm.runInContext(background,context);
  return {send:(message,sender={id:'fixture',url:'chrome-extension://fixture/popup.html'})=>new Promise(resolve=>listener(message,sender,resolve)),
    saved:()=>structuredClone(saved),calls:()=>calls};
}
const url=slug=>'https://soundcloud.com/fixture/'+slug;
const data={format:'soundcloud-highlight-backup',version:1,exportedAt:now,
  cache:[{url:url('yes'),expires:now+3600000,result:{status:'ok',reasons:['Buy リンク'],complete:true}},
    {url:url('no'),expires:now+3600000,result:{status:'ok',reasons:[],complete:true}},
    {url:url('expired'),expires:now-1,result:{status:'ok',reasons:['Download'],complete:true}}],
  limits:{windowStart:now-60000,count:42,lastStart:now-4000,cooldownUntil:now+1800000}};
(async()=>{
  const source=worker();
  const imported=await source.send({type:'sch-backup-import',backup:data});
  assert.equal(imported.added,2);assert.equal(imported.expired,1);
  const exported=await source.send({type:'sch-backup-export'});
  const serialized=JSON.parse(JSON.stringify(exported.backup));
  assert.equal(serialized.cache.length,2);
  const target=worker();
  assert.equal((await target.send({type:'sch-backup-import',backup:serialized})).added,2);
  const sender={tab:{id:1},url:'https://soundcloud.com/search'};
  assert.equal((await target.send({type:'sch-track-info',url:url('yes')},sender)).status,'ok');
  assert.equal((await target.send({type:'sch-track-info',url:url('no')},sender)).reasons.length,0);
  assert.equal(target.calls(),0);
  const state=target.saved()['sch-inspections-v18'];
  assert.equal(state.cache[url('yes')].expires,data.cache[0].expires);
  assert.equal(state.count,42);assert.equal(state.cooldownUntil,data.limits.cooldownUntil);
  assert.equal((await target.send({type:'sch-track-info',url:url('new')},sender)).status,'deferred');
  assert.equal(target.calls(),0);
  console.log('PASS export/import preserves positive and negative results, original expiry, rate budget and cooldown; no refetch');
  const before=JSON.stringify(target.saved());
  const invalid=structuredClone(serialized);
  invalid.cache[0].url='https://example.com/fixture/yes';
  assert.equal((await target.send({type:'sch-backup-import',backup:invalid})).status,'error');
  assert.equal(JSON.stringify(target.saved()),before);
  assert.equal((await target.send({type:'sch-backup-export'},sender)).status,'error');
  console.log('PASS malformed import is atomic and transfer controls only accept own popup');
  const newer=structuredClone(serialized);
  newer.cache[0].expires+=1000;
  assert.equal((await target.send({type:'sch-backup-import',backup:newer})).added,1);
  assert.equal((await target.send({type:'sch-backup-import',backup:serialized})).added,0);
  assert.equal(target.saved()['sch-inspections-v18'].cache[url('yes')].expires,newer.cache[0].expires);
  now+=7200000;
  assert.equal((await worker().send({type:'sch-backup-import',backup:serialized})).expired,2);
  console.log('PASS merge retains newer local records; stale backup does not renew lifetime');
})().catch(error=>{console.error(error);process.exitCode=1;});
