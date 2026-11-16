const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const metadata = fs.readFileSync(path.join(__dirname, '..', 'metadata.js'), 'utf8');
let saved = {}, calls = [], listener;
let now = 100000000;
const Clock = class extends Date {static now(){return now;}};
const sandbox = {
  URL, AbortController, Date:Clock, Promise, setTimeout:callback => {queueMicrotask(callback); return 1;}, clearTimeout(){},
  chrome:{storage:{local:{get:async()=>structuredClone(saved),set:async value=>{saved=structuredClone(value);}}},
    runtime:{onMessage:{addListener:callback=>{listener=callback;}}}},
  fetch:async url=>{calls.push({url,time:now});return {ok:true,status:200,headers:{get:()=>null},text:async()=> 'window.__sc_hydration = '+JSON.stringify([{kind:'track',permalink_url:url,downloadable:true,has_downloads_left:true}])+';'};}
};
function startWorker(){
  const context=vm.createContext({...sandbox});
  context.importScripts=()=>vm.runInContext(metadata,context);
  context.setTimeout=(callback,delay)=>{if(delay===10000)return 1;now+=delay;queueMicrotask(callback);return 1;};
  vm.runInContext(code,context);
  return context;
}
const request=url=>new Promise(resolve=>listener({type:'sch-track-info',url},{tab:{id:1},url:'https://soundcloud.com/search'},resolve));
(async()=>{
  startWorker();
  const a='https://soundcloud.com/fixture/a', b='https://soundcloud.com/fixture/b';
  await Promise.all([request(a),request(a),request(b)]);
  assert.equal(calls.length,2);
  assert(calls[1].time-calls[0].time>=4000);
  console.log('PASS duplicate requests coalesced and starts spaced by >=4 seconds');
  startWorker();
  await request(a);
  assert.equal(calls.length,2);
  console.log('PASS persisted cache survives worker restart');
  for(let i=0;i<58;i++)await request('https://soundcloud.com/fixture/item'+i);
  const limited=await request('https://soundcloud.com/fixture/over-limit');
  assert.equal(limited.status,'deferred');assert.equal(calls.length,60);
  console.log('PASS global hourly limit stops further network requests');
  saved['sch-inspections-v18'].count=0;saved['sch-inspections-v18'].windowStart=now;
  sandbox.fetch=async()=>{calls.push({time:now});return {ok:false,status:429,headers:{get:()=>null}};};
  startWorker();
  const response=await request('https://soundcloud.com/fixture/throttled');
  assert.equal(response.status,'deferred');
  const count=calls.length;
  await request('https://soundcloud.com/fixture/after-throttle');
  assert.equal(calls.length,count);
  console.log('PASS HTTP 429 stops requests during cooldown');
  saved['sch-inspections-v18'].count=0;saved['sch-inspections-v18'].windowStart=now;saved['sch-inspections-v18'].cooldownUntil=0;
  sandbox.fetch=async()=>{calls.push({time:now});return {ok:false,status:503,headers:{get:()=>null}};};
  startWorker();
  const failedURL='https://soundcloud.com/fixture/failed';
  const failed=await request(failedURL),failedCalls=calls.length;
  assert.equal(failed.status,'error');assert.equal(failed.nextAt,now+10*60*1000);
  assert.equal((await request(failedURL)).nextAt,failed.nextAt);assert.equal(calls.length,failedCalls);
  startWorker();assert.equal((await request(failedURL)).nextAt,failed.nextAt);assert.equal(calls.length,failedCalls);
  now=failed.nextAt;
  await request(failedURL);assert.equal(calls.length,failedCalls+1);
  console.log('PASS errors expose the original 10-minute retry deadline and do not refetch before expiry');
})().catch(error=>{console.error(error);process.exitCode=1;});
