import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import {mkdtemp,rm,readFile,symlink,mkdir,lstat,writeFile,rmdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';import {once} from 'node:events';import {DatabaseSync} from 'node:sqlite';
import {createProductService,configuration} from '../product/service.mjs';import {Store} from '../product/store.mjs';import {publicAddress,publicUrl,pinDestination,publicRequest,lookupProof,redactedPreview} from '../product/outbound.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'checkpoint-product-'));t.after(()=>rm(dir,{recursive:true,force:true}));const receipts=[],requests=[];let ledgerPath;
 const receiver=http.createServer(async(req,res)=>{let parts=[];for await(const chunk of req)parts.push(chunk);const text=Buffer.concat(parts).toString();requests.push({method:req.method,path:req.url,headers:req.headers,body:text});
  if(req.method==='POST'){if(ledgerPath){const db=new DatabaseSync(ledgerPath,{readOnly:true});assert.equal(db.prepare('SELECT state FROM deliveries LIMIT 1').get().state,'delivering');db.close();}receipts.push({reference:req.headers['x-checkpoint-reference'],payload:JSON.parse(text)});if(req.url==='/drop'){req.socket.destroy();return;}if(req.url==='/error'){res.writeHead(500);res.end('{"committed":true}');return;}if(req.url==='/redirect'){res.writeHead(307,{location:'/post'});res.end();return;}res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({accepted:true,echo:req.headers.authorization??null,secret:'do-not-store'}));return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({receipts:req.url==='/duplicate'?[...receipts,...receipts]:req.url==='/empty'?[]:receipts}));
 });await new Promise(r=>receiver.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{receiver.close(r);receiver.closeAllConnections();}));const port=receiver.address().port;
 // Trusted test adapter only: actual loopback HTTP, never configurable through the API.
 const transport=(value,options)=>new Promise(resolve=>{const u=publicUrl(value);const req=http.request({hostname:'127.0.0.1',port,path:u.pathname,method:options.method,headers:options.headers},res=>{let chunks=[],size=0;res.on('data',c=>{size+=c.length;chunks.push(c);});res.on('end',()=>resolve({state:options.method==='POST'&&res.statusCode>=200&&res.statusCode<300?'delivered':'unknown',httpStatus:res.statusCode,rawBody:Buffer.concat(chunks),responseBytes:size,reason:'Observed actual controlled HTTP response'}));});req.on('error',()=>resolve({state:'unknown',safeRetry:false,reason:'Controlled receiver disconnected after possible commit',responseBytes:0,bodyPreview:''}));options.signal?.addEventListener('abort',()=>req.destroy(),{once:true});req.end(options.body);});
 const dataDir=join(dir,'data'),service=await createProductService({dataDir,transport});const address=await service.listen(0,'127.0.0.1');t.after(()=>service.close());const url=`http://127.0.0.1:${address.port}`;
 const call=async(path,{token,body,method=body===undefined?'GET':'POST'}={})=>{const res=await fetch(url+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:res.status===204?null:await res.json()};};
 return {dir,dataDir,service,receiver,port,url,call,receipts,requests,transport,setLedgerPath:path=>{ledgerPath=path;}};
}
const draft=(path='/post',extra={})=>({destination:'https://delivery.example.org'+path,reference:'invoice-1',payload:{hello:'world'},idempotency:null,lookup:null,credential:null,...extra});
async function workspace(f){return (await f.call('/api/workspaces',{body:{}})).body.token;}
async function create(f,token,config=draft()){const r=await f.call('/api/deliveries',{token,body:config});assert.equal(r.status,201);return r.body.delivery;}
test('actual outbound HTTP persists intent first, records acknowledgement and preserves private restart history',async t=>{
 const f=await fixture(t),token=await workspace(f);const job=await create(f,token);assert.equal(job.state,'queued');assert.equal(f.receipts.length,0);f.setLedgerPath(join(f.dataDir,'workspace.sqlite'));
 const sent=await f.call('/api/deliveries/'+job.id+'/send',{token,body:{credential:{name:'Authorization',value:'Bearer PRIVATE-KEY'}}});assert.equal(sent.body.delivery.state,'delivered');assert.equal(f.receipts.length,1);assert.equal(f.requests[0].headers.authorization,'Bearer PRIVATE-KEY');assert.deepEqual(f.receipts[0].payload,{hello:'world'});assert.equal(sent.body.delivery.attempts.length,1);assert.match(sent.body.delivery.attempts[0].bodyPreview,/omitted/);
 assert.equal((await f.call('/api/deliveries/'+job.id+'/retry',{token,body:{riskConfirmed:true}})).status,409);assert.equal(f.receipts.length,1);
 const exported=(await f.call('/api/export',{token})).body;assert.ok(!JSON.stringify(exported).includes('PRIVATE-KEY'));assert.ok(!JSON.stringify(exported).includes(token));
 await f.service.close();const disk=new Store(f.dataDir);assert.equal(disk.detail(disk.authorize(token),job.id).state,'delivered');assert.throws(()=>new Store(f.dataDir),/live service owner/);disk.close();
 const bytes=await readFile(join(f.dataDir,'workspace.sqlite'));assert.ok(!bytes.includes(Buffer.from(token)));assert.ok(!bytes.includes(Buffer.from('PRIVATE-KEY')));
});
test('workspace isolation, exact references and deletion do not leak private delivery existence',async t=>{
 const f=await fixture(t),a=await workspace(f),b=await workspace(f),job=await create(f,a);assert.equal((await f.call('/api/deliveries')).status,401);assert.equal((await f.call('/api/deliveries/'+job.id,{token:b})).status,404);assert.equal((await f.call('/api/deliveries/'+job.id,{token:b,method:'DELETE'})).status,404);assert.deepEqual((await f.call('/api/deliveries',{token:b})).body.deliveries,[]);
 assert.equal((await f.call('/api/deliveries',{token:a,body:draft()})).status,409);assert.equal((await f.call('/api/deliveries/'+job.id,{token:a,method:'DELETE'})).status,204);assert.equal((await f.call('/api/deliveries/'+job.id,{token:a})).status,404);
});
test('commit then disconnect remains unknown; absent lookup never permits retry; explicit risk is audited',async t=>{
 const f=await fixture(t),token=await workspace(f),job=await create(f,token,draft('/drop'));
 const sent=(await f.call('/api/deliveries/'+job.id+'/send',{token,body:{}})).body.delivery;assert.equal(sent.state,'unknown');assert.equal(f.receipts.length,1);assert.equal(sent.canRetrySafely,false);
 assert.equal((await f.call('/api/deliveries/'+job.id+'/send',{token,body:{}})).status,409);assert.equal((await f.call('/api/deliveries/'+job.id+'/retry',{token,body:{}})).status,409);assert.equal(f.receipts.length,1);
 const reviewed=(await f.call('/api/deliveries/'+job.id,{token})).body.delivery;assert.equal(reviewed.state,'needs_review');
 const retried=(await f.call('/api/deliveries/'+job.id+'/retry',{token,body:{riskConfirmed:true}})).body.delivery;assert.equal(f.receipts.length,2);assert.ok(retried.events.some(e=>/confirmed duplicate risk/.test(e.reason)));
});
test('HTTP 500 and redirects after dispatch are ambiguous and are never followed or automatically retried',async t=>{
 const f=await fixture(t),token=await workspace(f);
 for(const [path,ref]of [['/error','error'],['/redirect','redirect']]){const job=await create(f,token,draft(path,{reference:ref}));const r=(await f.call('/api/deliveries/'+job.id+'/send',{token,body:{}})).body.delivery;assert.equal(r.state,'unknown');assert.equal(r.canRetrySafely,false);assert.equal(r.attempts.length,1);}
 assert.equal(f.receipts.length,2);assert.equal(f.requests.length,2);
});
test('strict unique lookup verifies reference only; duplicate/conflicting or absent proof requests review',async t=>{
 const f=await fixture(t),token=await workspace(f),lookup={url:'https://delivery.example.org/lookup',recordsPointer:'/receipts',referencePointer:'/reference'};
 const job=await create(f,token,draft('/drop',{lookup}));await f.call('/api/deliveries/'+job.id+'/send',{token,body:{}});const r=(await f.call('/api/deliveries/'+job.id+'/reconcile',{token,body:{}})).body.delivery;assert.equal(r.state,'delivered');assert.equal(r.evidence.reference,'invoice-1');assert.equal(r.evidence.kind,'unique_reference_lookup');assert.equal(f.receipts.length,1);assert.equal(r.attempts[1].kind,'lookup');
 for(const records of [[],[{reference:'different'}],[{reference:'x'},{reference:'x'}],[{reference:'x'},{}]])assert.equal(lookupProof(Buffer.from(JSON.stringify({receipts:records})),lookup,'x'),null);
});
test('declared idempotency contract permits an explicit retry but never schedules one itself',async t=>{
 const f=await fixture(t),token=await workspace(f),job=await create(f,token,draft('/drop',{idempotency:{header:'Idempotency-Key',key:'stable-key',contract:true}}));let r=(await f.call('/api/deliveries/'+job.id+'/send',{token,body:{}})).body.delivery;assert.equal(r.state,'unknown');assert.equal(r.canRetrySafely,true);assert.equal(f.receipts.length,1);r=(await f.call('/api/deliveries/'+job.id+'/retry',{token,body:{}})).body.delivery;assert.equal(f.receipts.length,2);assert.equal(f.requests[0].headers['idempotency-key'],f.requests[1].headers['idempotency-key']);assert.equal(r.attemptCount,2);
});
test('pre-dispatch rejection is safely failed, while same-job concurrent dispatch is claimed once',async t=>{
 const f=await fixture(t),token=await workspace(f);await f.service.close();let release;const waiting=new Promise(r=>{release=r;});let calls=0;
 const service=await createProductService({dataDir:f.dataDir,transport:async()=>{calls++;await waiting;return {state:'failed',safeRetry:true,reason:'Rejected before transmission',responseBytes:0,bodyPreview:''};}});const a=await service.listen(0,'127.0.0.1');t.after(()=>service.close());const endpoint=`http://127.0.0.1:${a.port}/api/deliveries`;const auth={authorization:'Bearer '+token,'content-type':'application/json'};
 const created=await(await fetch(endpoint,{method:'POST',headers:auth,body:JSON.stringify(draft())})).json();const pending=fetch(endpoint+'/'+created.delivery.id+'/send',{method:'POST',headers:auth,body:'{}'});while(!calls)await new Promise(r=>setTimeout(r,1));const parallel=await fetch(endpoint+'/'+created.delivery.id+'/send',{method:'POST',headers:auth,body:'{}'});assert.equal(parallel.status,409);release();const r=(await(await pending).json()).delivery;assert.equal(calls,1);assert.equal(r.state,'failed');assert.equal(r.canRetrySafely,true);
});
test('actual process death after receiver commit recovers unknown without a second delivery',async t=>{
 const f=await fixture(t),token=await workspace(f),job=await create(f,token);await f.service.close();f.setLedgerPath(join(f.dataDir,'workspace.sqlite'));
 const script=`import {Store} from ${JSON.stringify(new URL('../product/store.mjs',import.meta.url).href)};const s=new Store(${JSON.stringify(f.dataDir)});const o=s.authorize(${JSON.stringify(token)});s.claim(o,${JSON.stringify(job.id)},'send');await fetch('http://127.0.0.1:${f.port}/post',{method:'POST',headers:{'Content-Type':'application/json','X-Checkpoint-Reference':'invoice-1'},body:'{"hello":"world"}'});process.exit(23);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});const [code]=await once(child,'exit');assert.equal(code,23);assert.equal(f.receipts.length,1);
 const recovered=new Store(f.dataDir),detail=recovered.detail(recovered.authorize(token),job.id);assert.equal(detail.state,'unknown');assert.equal(detail.attempts[0].status,'unknown');assert.match(detail.events.at(-1).reason,/Process restarted/);assert.equal(f.receipts.length,1);recovered.close();
});
test('SSRF public address guard rejects private, mapped, metadata, documentation and mixed DNS answers',async()=>{
 for(const ip of ['0.0.0.0','10.0.0.1','127.0.0.1','100.64.0.1','169.254.169.254','168.63.129.16','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::a00:1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1','3fff::1'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(ip),true,ip);
 for(const u of ['http://example.org','https://127.0.0.1/','https://169.254.169.254/','https://[::ffff:127.0.0.1]/','https://example.org:444/','https://user:password@example.org/','https://localhost/','https://service.internal/'])assert.throws(()=>publicUrl(u));
 await assert.rejects(pinDestination('https://delivery.example.org',{resolver:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]}));
});
test('production transport pins one DNS result, keeps TLS identity and reads an actual bounded HTTP test response',async t=>{
 const f=await fixture(t);let resolutions=0,captured;
 const result=await publicRequest('https://delivery.example.org/post',{method:'POST',body:'{}',headers:{'X-Checkpoint-Reference':'pin-test'},resolver:async()=>{resolutions++;return [{address:'8.8.8.8',family:4}];},requestImpl:(options,callback)=>{captured=options;options.lookup(options.hostname,{all:true},(error,rows)=>assert.deepEqual(rows,[{address:'8.8.8.8',family:4}]));return http.request({hostname:'127.0.0.1',port:f.port,path:options.path,method:options.method,headers:options.headers},callback);}});
 assert.equal(result.state,'delivered');assert.equal(resolutions,1);assert.equal(captured.servername,'delivery.example.org');assert.equal(captured.rejectUnauthorized,true);assert.equal(captured.agent,false);assert.equal(f.receipts.length,1);
});
test('configuration and response redaction reject unsafe headers/pointers and never retain credential echoes',()=>{
 for(const change of [{destination:'http://example.org'},{reference:'../bad'},{payload:Infinity},{lookup:{url:'https://example.org',recordsPointer:'bad',referencePointer:'/reference'}},{idempotency:{header:'Host',key:'x',contract:true}},{credential:{name:'Authorization',value:'bad\r\nHost: internal'}}])assert.throws(()=>configuration(draft('/post',change)));
 const secret='private"\\secret';const preview=redactedPreview(Buffer.from(JSON.stringify({echo:secret,encoded:Buffer.from(secret).toString('base64')})),secret);assert.ok(!preview.includes(secret));assert.match(preview,/omitted/);
 assert.equal(JSON.parse(redactedPreview(Buffer.from('{"token":"sensitive","ok":true}'))).token,'[REDACTED]');
});

test('native Vercel relay forwards parsed JSON and only the intended authentication headers',async()=>{
 const {default:relay}=await import('../api/product.js');const original=globalThis.fetch;let captured;
 globalThis.fetch=async(url,options)=>{captured={url,options};return new Response('{"deliveries":[]}',{status:200,headers:{'content-type':'application/json'}});};
 const output={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;},end(){}};
 try{await relay({url:'/api/product?path=%2Fapi%2Fdeliveries',method:'POST',headers:{origin:'https://steel-checkpoint.vercel.app',authorization:'Bearer workspace-private',cookie:'do-not-forward','content-length':'999','content-type':'application/json'},body:{destination:'https://example.org/webhook',reference:'relay',payload:{real:true}}},output);assert.equal(output.statusCode,200);assert.equal(captured.url,'https://checkpoint-production-81f4.up.railway.app/api/deliveries');assert.equal(JSON.parse(captured.options.body).reference,'relay');assert.deepEqual(Object.keys(captured.options.headers).sort(),['Authorization','Content-Type','Origin']);assert.equal(captured.options.redirect,'manual');}
 finally{globalThis.fetch=original;}
});

test('flat native relay preserves nested delivery paths and rejects ambiguous routing before fetch',async()=>{
 const {default:relay}=await import('../api/product.js');const original=globalThis.fetch;let calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,method:options.method});return new Response('{"delivery":{"state":"queued"}}',{status:200});};
 const output=()=>({setHeader(){},status(n){this.statusCode=n;return this;},json(v){this.value=v;return this;},end(){}});
 const id='12345678-abcd-1234-abcd-123456789abc';
 try{
  for(const [method,path]of [['GET','/api/deliveries/'+id],['POST','/api/deliveries/'+id+'/send'],['POST','/api/deliveries/'+id+'/reconcile'],['POST','/api/deliveries/'+id+'/retry'],['DELETE','/api/deliveries/'+id]]){
   const out=output();await relay({url:'/api/product?path='+encodeURIComponent(path),method,headers:{'content-type':'application/json'},body:method==='POST'?{}:undefined},out);assert.equal(out.statusCode,200);assert.equal(calls.at(-1).url,'https://checkpoint-production-81f4.up.railway.app'+path);assert.equal(calls.at(-1).method,method);
  }
  const before=calls.length;
  for(const url of ['/api/product','/api/product?path=/api/export&path=/api/workspaces','/api/product?path=/api/export&other=1','/api/product?path=https://example.org/api/export','/api/product?path=/api/deliveries/'+id+'/send?x=1','/api/product?path=/api/../export','/api/product?path=%252Fapi%252Fexport','/api/deliveries/'+id]){
   const out=output();await relay({url,method:'GET',headers:{}},out);assert.ok([400,404].includes(out.statusCode),url);
  }
  assert.equal(calls.length,before);
 }finally{globalThis.fetch=original;}
});

test('root launcher fails without explicit drop and refuses untrusted DATA_DIR before opening HTTP',async t=>{
 if(process.getuid?.()!==0){t.skip('root capability unavailable');return;}
 for(const env of [{DROP_PRIVILEGES:'0',DATA_DIR:'/data/checkpoint'},{DROP_PRIVILEGES:'1',DATA_DIR:'/etc/checkpoint-untrusted'}]){
  const child=spawn(process.execPath,['scripts/launch.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'production',...env},stdio:'ignore'});const [code]=await once(child,'exit');assert.notEqual(code,0);
 }
});

test('trusted production root launch traverses volume then serves only after UID/GID drop',async t=>{
 if(process.getuid?.()!==0){t.skip('root capability unavailable');return;}
 try{await lstat('/data');t.skip('refusing to alter a preexisting /data mount');return;}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir('/data',{mode:0o700});await writeFile('/data/sibling-do-not-chown','test',{mode:0o600});
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['scripts/launch.mjs','--host','127.0.0.1','--port',String(port)],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'production',DATA_DIR:'/data/checkpoint',DROP_PRIVILEGES:'1'},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 try{await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('trusted launch timed out: '+stderr)),3000);child.stdout.on('data',bytes=>{output+=bytes;if(output.includes('listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('trusted launch exited '+code+': '+stderr));});});const ready=await(await fetch(`http://127.0.0.1:${port}/api/ready`)).json();assert.equal(ready.runtimeUid,1000);assert.equal((await lstat('/data')).mode&0o777,0o711);const directory=await lstat('/data/checkpoint');assert.equal(directory.uid,1000);assert.equal(directory.gid,1000);assert.equal(directory.mode&0o777,0o700);const sibling=await lstat('/data/sibling-do-not-chown');assert.equal(sibling.uid,0);assert.equal(sibling.mode&0o777,0o600);}
 catch(error){if(/fatal library error|EPERM|Operation not permitted|EINVAL: invalid argument, fchown/.test(error.message))t.skip('managed host does not permit privilege-drop filesystem execution');else throw error;}
 finally{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await exit;clearTimeout(timer);}await rm('/data/checkpoint',{recursive:true,force:true});await rm('/data/sibling-do-not-chown');await rmdir('/data').catch(()=>{});}
});

test('real empty receipt lookup records review and cannot become retry permission',async t=>{
 const f=await fixture(t),token=await workspace(f),job=await create(f,token,draft('/drop',{lookup:{url:'https://delivery.example.org/empty',recordsPointer:'/receipts',referencePointer:'/reference'}}));
 await f.call('/api/deliveries/'+job.id+'/send',{token,body:{}});const checked=(await f.call('/api/deliveries/'+job.id+'/reconcile',{token,body:{}})).body.delivery;assert.equal(checked.state,'needs_review');assert.equal(checked.canRetrySafely,false);assert.equal((await f.call('/api/deliveries/'+job.id+'/retry',{token,body:{}})).status,409);assert.equal(f.receipts.length,1);
});
test('expired workspace prunes private history and configured data directory never falls back',async t=>{
 const f=await fixture(t),token=await workspace(f),job=await create(f,token);const owner=f.service.store.authorize(token);f.service.store.db.prepare("UPDATE workspaces SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?").run(owner);
 assert.equal((await f.call('/api/deliveries/'+job.id,{token})).status,401);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);assert.ok(f.service.store.db.prepare('PRAGMA max_page_count').get().max_page_count<=16384);
 await assert.rejects(createProductService({dataDir:'relative-untrusted'}),/DATA_DIR/);const file=join(f.dir,'not-a-directory');await writeFile(file,'private');await assert.rejects(createProductService({dataDir:file}));
});
test('production transport times out and refuses oversized response without retaining raw body',async t=>{
 const server=http.createServer((req,res)=>{req.resume();if(req.url==='/large'){res.writeHead(200);res.end('x'.repeat(40000));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const port=server.address().port;
 const options={method:'POST',body:'{}',timeoutMs:30,resolver:async()=>[{address:'8.8.8.8',family:4}],requestImpl:(o,cb)=>http.request({hostname:'127.0.0.1',port,path:o.path,method:o.method,headers:o.headers},cb)};
 const timed=await publicRequest('https://delivery.example.org/hang',options);assert.equal(timed.state,'unknown');assert.match(timed.reason,/time budget/);const large=await publicRequest('https://delivery.example.org/large',options);assert.equal(large.state,'unknown');assert.equal(large.rawBody,undefined);assert.ok(large.responseBytes>32768);
});

test('local dev entrypoint supports preview flags and refuses production or Railway',async t=>{
 for(const blocked of [{NODE_ENV:'production',RAILWAY_ENVIRONMENT_ID:''},{NODE_ENV:'development',RAILWAY_ENVIRONMENT_ID:'test-railway'}]){const child=spawn(process.execPath,['scripts/dev.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,...blocked},stdio:'ignore'});const [code]=await once(child,'exit');assert.notEqual(code,0);}
 const directory=await mkdtemp(join(tmpdir(),'checkpoint-dev-entry-'));t.after(()=>rm(directory,{recursive:true,force:true}));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['scripts/dev.mjs','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'development',RAILWAY_ENVIRONMENT_ID:'',DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('dev entry timeout')),3000);child.stdout.on('data',b=>{if(String(b).includes('listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('dev exited '+code));});});assert.equal((await fetch(`http://127.0.0.1:${port}/api/ready`)).status,200);}
 finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
 assert.equal(child.exitCode,0);
});
