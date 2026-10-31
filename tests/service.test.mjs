import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,rm,mkdir,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createService,parseConfig,runWorker,startOptions,publicOriginSetting} from '../lab-server.mjs';
const config={mode:'observable',fault:'after_commit',visibilityDelayMs:0};
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'checkpoint-http-test-')),web=join(directory,'web');await mkdir(web);await writeFile(join(web,'index.html'),'<!doctype html><h1>test fixture</h1>');await writeFile(join(web,'app.js'),'export const ready=true;');
 const service=await createService({webRoot:web,...options}),address=await service.listen(0,'127.0.0.1');
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
 return {service,url:`http://127.0.0.1:${address.port}`,directory,web};
}
const post=(url,body)=>fetch(url+'/api/run',{method:'POST',headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
const waitUntil=async predicate=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
const runDirs=async()=>new Set((await readdir(tmpdir())).filter(name=>name.startsWith('checkpoint-run-')));
test('strict flat JSON schema rejects duplicate/unknown/nested keys and malformed primitives',()=>{
 assert.deepEqual(parseConfig(JSON.stringify(config)),config);
 for(const raw of ['\u00a0'+JSON.stringify(config),'[]','null','{}','{"mode":"opaque","mode":"observable","fault":"none","visibilityDelayMs":0}','{"mode":"observable","m\\u006fde":"opaque","fault":"none","visibilityDelayMs":0}',JSON.stringify({...config,visibilityDelayMs:true}),JSON.stringify({...config,visibilityDelayMs:301}),JSON.stringify({...config,visibilityDelayMs:0.5}),JSON.stringify({...config,url:'http://example.com'}),JSON.stringify({...config,mode:{name:'observable'}}),JSON.stringify({...config,mode:'remote'}),'{"mode":"observable",}','{"__proto__":"x"}'])assert.throws(()=>parseConfig(raw),/configuration|JSON|keys|key|Use|Expected/);
});
test('actual API comparison records real journal traces, detects duplicate and cleans temporary files',async t=>{
 const {url,service}=await fixture(t);const before=await runDirs();const response=await post(url,config);assert.equal(response.status,200);const r=await response.json();
 assert.equal(r.naive.state,'verified');assert.equal(r.naive.attempts,2);assert.equal(r.naive.records,2);assert.equal(r.naive.duplicates,1);assert.equal(r.reconcile.records,1);assert.equal(r.reconcile.attempts,1);assert.equal(r.reconcile.state,'verified');
 assert.ok(r.reconcile.events.some(e=>e.state==='outcome_unknown'));assert.ok(r.reconcile.events.every(e=>Number.isFinite(e.timestamp)&&Number.isInteger(e.id)));assert.equal(r.summary.integrationStatus,'unverified');assert.match(r.summary.oracle,/never recovery input/);
 assert.equal(r.reconcile.receipt.amount,1250);assert.equal(service.stats().active,0);assert.equal(service.stats().children,0);assert.deepEqual(await runDirs(),before);
});
test('actual delayed recovery polls pending without re-submission; independent runs share no state',async t=>{
 const {url}=await fixture(t);const a=await(await post(url,{...config,visibilityDelayMs:100})).json();const b=await(await post(url,{...config,fault:'none'})).json();
 assert.notEqual(a.runId,b.runId);assert.equal(a.reconcile.state,'verified');assert.equal(a.reconcile.attempts,1);assert.equal(a.reconcile.records,1);assert.ok(a.reconcile.history.some(h=>h.state==='pending'));assert.ok(a.reconcile.history.length>1);assert.equal(a.reconcile.history.at(-1).state,'verified');
 assert.equal(b.naive.records,1);assert.equal(b.reconcile.records,1);assert.equal(b.naive.duplicates,0);assert.equal(b.reconcile.receipt.id,1);
});
test('opaque unknown and idempotent positive controls preserve honest differences',async t=>{
 const {url}=await fixture(t);const opaque=await(await post(url,{...config,mode:'opaque'})).json();assert.equal(opaque.reconcile.state,'needs_review');assert.equal(opaque.reconcile.receipt,null);assert.equal(opaque.naive.duplicates,1);
 const idem=await(await post(url,{...config,mode:'idempotent'})).json();assert.equal(idem.naive.duplicates,0);assert.equal(idem.reconcile.state,'verified');
 const rejected=await(await post(url,{...config,fault:'before_commit'})).json();assert.equal(rejected.naive.attempts,2);assert.equal(rejected.reconcile.attempts,2);assert.equal(rejected.reconcile.records,1);
});
test('HTTP enforces type/size/schema/method limits and never returns internal errors',async t=>{
 const {url}=await fixture(t);assert.equal((await fetch(url+'/api/run')).status,405);
 assert.equal((await fetch(url+'/api/run',{method:'POST',body:'x'})).status,415);
 for(const raw of ['{',JSON.stringify({...config,directory:'/tmp'})]){const response=await post(url,raw);assert.equal(response.status,400);assert.ok(!(await response.text()).includes('/workspace'));}
 assert.equal((await post(url,'x'.repeat(16385))).status,413);
 assert.equal((await fetch(url+'/api/absent')).status,404);
});
test('static assets have self CSP and MIME; traversal, symlink escape and unsupported extension are blocked',async t=>{
 const {url,directory,web}=await fixture(t);await writeFile(join(directory,'private.html'),'SECRET');await symlink(join(directory,'private.html'),join(web,'escape.html'));await writeFile(join(web,'private.sqlite'),'SECRET');
 const html=await fetch(url);assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(html.headers.get('x-content-type-options'),'nosniff');
 assert.match((await fetch(url+'/app.js')).headers.get('content-type'),/text\/javascript/);assert.equal((await fetch(url+'/escape.html')).status,404);assert.equal((await fetch(url+'/private.sqlite')).status,404);
 for(const path of ['/..%2Fprivate.html','/%252e%252e/private.html','/%zz','/foo%5Cbar']){
  const status=await new Promise((resolve,reject)=>{const req=http.get(url+path,res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,400);
 }
});
test('capacity two returns 429 with retry guidance; completion permits later requests',async t=>{
 let release;const blocked=new Promise(resolve=>{release=resolve;});let entered=0;
 const worker=async()=>{entered++;await blocked;return {runId:'test',naive:{},reconcile:{},summary:{}};};
 const {url,service}=await fixture(t,{worker});const a=post(url,config),b=post(url,config);await waitUntil(()=>entered===2);assert.equal(service.stats().active,2);
 const busy=await post(url,config);assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'1');release();assert.equal((await a).status,200);assert.equal((await b).status,200);assert.equal((await post(url,config)).status,200);
});
test('global rate window is bounded and recovers, including new connections',async t=>{
 const {url,service}=await fixture(t,{rateLimit:2,rateWindowMs:50,worker:async()=>({runId:'test'})});
 assert.equal((await post(url,config)).status,200);assert.equal((await post(url,config)).status,200);assert.equal((await post(url,config)).status,429);assert.equal(service.stats().rateEntries,2);
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal((await post(url,config)).status,200);assert.equal(service.stats().rateEntries,1);
});
test('readiness and concurrent shutdown are awaitable; fixed worker failure has safe HTTP response',async t=>{
 const {url,service}=await fixture(t,{worker:async()=>{throw Error('secret /path traceback');}});const ready=await(await fetch(url+'/api/ready')).json();assert.equal(ready.ready,true);assert.equal(ready.capacity,2);assert.equal((await fetch(url+'/api/health')).status,200);assert.equal((await fetch(url+'/healthz')).status,200);assert.equal((await fetch(url+'/readyz')).status,200);
 const response=await post(url,config);assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Request could not complete'});
 await Promise.all([service.close(),service.close()]);assert.equal(service.server.listening,false);assert.equal(service.stats().active,0);
});
test('actual fixed process timeout terminates process group and removes run workspace',async()=>{
 const before=await runDirs();let pid;
 await assert.rejects(runWorker(config,{timeoutMs:1,onSpawn:child=>{pid=child.pid;}}),error=>error.status===504);
 assert.throws(()=>process.kill(pid,0),/ESRCH/);assert.deepEqual(await runDirs(),before);
});
test('HTTP client disconnect aborts actual process and releases capacity and workspace',async t=>{
 let pid;const {url,service}=await fixture(t,{worker:(configuration,options)=>runWorker(configuration,{...options,onSpawn:child=>{pid=child.pid;options.onSpawn(child);}})});const before=await runDirs();
 const request=http.request(url+'/api/run',{method:'POST',headers:{'content-type':'application/json'}});request.on('error',()=>{});request.end(JSON.stringify({...config,visibilityDelayMs:300}));
 await waitUntil(()=>Boolean(pid));request.destroy();await waitUntil(()=>service.stats().active===0&&service.stats().children===0);assert.throws(()=>process.kill(pid,0),/ESRCH/);assert.deepEqual(await runDirs(),before);
});

test('readiness fails closed when the frontend entrypoint is missing',async t=>{
 const {url,web}=await fixture(t);await rm(join(web,'index.html'));
 const response=await fetch(url+'/api/ready');assert.equal(response.status,503);assert.equal((await response.json()).checks.frontend,false);
});
test('chunked oversized body is bounded; slow body receives a configured timeout',async t=>{
 const {url}=await fixture(t);
 const chunked=await new Promise((resolve,reject)=>{const req=http.request(url+'/api/run',{method:'POST',headers:{'content-type':'application/json','transfer-encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('x'.repeat(16385));});assert.equal(chunked,413);
 const start=Date.now();const slow=await new Promise((resolve,reject)=>{const req=http.request(url+'/api/run',{method:'POST',headers:{'content-type':'application/json','content-length':'100'}},res=>{res.resume();resolve(res.statusCode);req.destroy();});req.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});req.write('{');});assert.equal(slow,408);assert.ok(Date.now()-start<4000);
});

test('dev startup honors preview host/port flags over PORT and stops on SIGTERM',async()=>{
 assert.deepEqual(startOptions([],{PORT:'4321'}),{host:'0.0.0.0',port:4321});
 assert.deepEqual(startOptions(['--host','127.0.0.1','--port','4173','--strictPort'],{PORT:'4321'}),{host:'127.0.0.1',port:4173});
 assert.throws(()=>startOptions(['--port','0']));assert.throws(()=>startOptions(['--host','example.com']));
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../lab-server.mjs',import.meta.url)),'--host','127.0.0.1','--port',String(port),'--strictPort'],{env:{...process.env,PORT:'1'},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('dev startup timed out')),3000);child.stdout.on('data',data=>{output+=data;if(output.includes('listening on 127.0.0.1:'+port)){clearTimeout(timer);resolve();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('dev exited '+code));});});
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/ready`)).status,200);
 }finally{const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2500);await exited;clearTimeout(timer);}
 assert.equal(child.exitCode,0);
});

test('spawn failure with synchronous cancellation never signals an undefined PID',async()=>{
 const controller=new AbortController(),before=await runDirs();
 await assert.rejects(runWorker(config,{signal:controller.signal,spawnProcess:(_command,args,options)=>spawn('/missing-checkpoint-test-executable',args,options),onSpawn:()=>controller.abort()}),error=>[499,503].includes(error.status));
 assert.deepEqual(await runDirs(),before);
});
test('shutdown waits for a disconnected worker to exit and for parent directory cleanup',async t=>{
 let pid;const {url,service}=await fixture(t,{worker:(configuration,options)=>runWorker(configuration,{...options,onSpawn:child=>{pid=child.pid;options.onSpawn(child);}})});const before=await runDirs();
 const request=http.request(url+'/api/run',{method:'POST',headers:{'content-type':'application/json'}});request.on('error',()=>{});request.end(JSON.stringify({...config,visibilityDelayMs:300}));await waitUntil(()=>Boolean(pid));request.destroy();await Promise.all([service.close(),service.close()]);assert.equal(service.stats().active,0);assert.equal(service.stats().children,0);assert.deepEqual(await runDirs(),before);
});

test('PUBLIC_ORIGIN startup setting accepts one canonical HTTPS origin and fails closed',async()=>{
 assert.equal(publicOriginSetting(undefined),null);assert.equal(publicOriginSetting('https://checkpoint.example'),'https://checkpoint.example');
 for(const value of ['',null,[],true,'*','https://*.example','http://checkpoint.example','https://checkpoint.example/','https://checkpoint.example/path','https://checkpoint.example?x=1','https://checkpoint.example#x','https://user:pass@checkpoint.example','https://CHECKPOINT.example','https://checkpoint.example:443','https://a.example,https://b.example']){
  assert.throws(()=>publicOriginSetting(value),/PUBLIC_ORIGIN/);
  await assert.rejects(createService({publicOrigin:value}),/PUBLIC_ORIGIN/);
 }
});
test('exact configured public origin gets bounded preflight and real API response',async t=>{
 const origin='https://checkpoint.example';const {url}=await fixture(t,{publicOrigin:origin});
 const preflight=await fetch(url+'/api/run',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.equal(preflight.headers.get('access-control-allow-methods'),'POST');assert.equal(preflight.headers.get('access-control-allow-credentials'),null);
 const response=await fetch(url+'/api/run',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(config)});assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal((await response.json()).reconcile.state,'verified');
});
test('direct same-connection origin and no-origin clients remain supported without forwarding trust',async t=>{
 const {url}=await fixture(t);
 const same=await fetch(url+'/api/health',{headers:{origin:url}});assert.equal(same.status,200);assert.equal(same.headers.get('access-control-allow-origin'),url);
 assert.equal((await fetch(url+'/api/health')).status,200);
 for(const origin of ['https://attacker.example','null',url.replace('http:','https:')]){
  const denied=await fetch(url+'/api/health',{headers:{origin,'x-forwarded-host':'attacker.example','x-forwarded-proto':'https',forwarded:'proto=https;host=attacker.example'}});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
 }
});
test('public-origin near-misses, extra preflight headers and unexpected methods are rejected',async t=>{
 const origin='https://checkpoint.example';const {url,service}=await fixture(t,{publicOrigin:origin});
 for(const impostor of ['https://checkpoint.example.attacker.test','https://sub.checkpoint.example','http://checkpoint.example','https://checkpoint.example:8443','https://checkpoint.example/']){
  const denied=await fetch(url+'/api/run',{method:'POST',headers:{origin:impostor,'content-type':'application/json'},body:JSON.stringify(config)});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
 }
 for(const headers of [{'access-control-request-method':'DELETE'},{'access-control-request-method':'POST','access-control-request-headers':'content-type, authorization'}]){
  assert.equal((await fetch(url+'/api/run',{method:'OPTIONS',headers:{origin,...headers}})).status,403);
 }
 assert.equal(service.stats().rateEntries,0);assert.equal(service.stats().active,0);
});
