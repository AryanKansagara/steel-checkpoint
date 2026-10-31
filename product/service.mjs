import http from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {join,resolve,relative,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store,ProductError,LIMITS} from './store.mjs';
import {publicRequest,publicUrl,pointer,lookupProof,redactedPreview} from './outbound.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const security={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
const fail=(code,message)=>new ProductError(400,code,message);
const keys=(value,allowed,required=[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw fail('invalid_request','Request has missing or unsupported fields');};
const forbidden=new Set(['host','content-type','content-length','connection','transfer-encoding','upgrade','te','trailer','expect','forwarded','x-forwarded-host','x-forwarded-proto','x-checkpoint-reference','proxy-authorization','proxy-connection']);
function header(name){if(typeof name!=='string'||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name)||forbidden.has(name.toLowerCase()))throw fail('invalid_header','That header name cannot be supplied');return name;}
export function credential(value){if(value==null)return null;keys(value,['name','value'],['name','value']);header(value.name);if(typeof value.value!=='string'||!value.value||Buffer.byteLength(value.value)>2048||/[\x00-\x1f\x7f]/.test(value.value))throw fail('invalid_credential','Credential value must be nonempty and free of control newlines');return {name:value.name,value:value.value};}
export function configuration(input){
 keys(input,['destination','reference','payload','idempotency','lookup','credential'],['destination','reference','payload']);credential(input.credential);
 const destination=publicUrl(input.destination).href;
 if(typeof input.reference!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.reference))throw fail('invalid_reference','Reference must be 1–128 ASCII letters, digits, dots, underscores, colons or hyphens');
 let encoded;try{const pending=[{value:input.payload,depth:0}];let visited=0;while(pending.length){const {value,depth}=pending.pop();if(++visited>2000||depth>16||typeof value==='number'&&!Number.isFinite(value))throw Error();if(value&&typeof value==='object')for(const child of Object.values(value))pending.push({value:child,depth:depth+1});}encoded=JSON.stringify(input.payload);}catch{throw fail('invalid_payload','Payload must be JSON');}if(encoded===undefined||Buffer.byteLength(encoded)>LIMITS.payloadBytes)throw fail('invalid_payload','JSON payload must fit in 16 KiB');
 let idempotency=null,lookup=null;
 if(input.idempotency!=null){const i=input.idempotency;keys(i,['header','key','contract'],['header','key','contract']);header(i.header);if(['authorization','cookie','set-cookie'].includes(i.header.toLowerCase())||i.contract!==true||typeof i.key!=='string'||!i.key||Buffer.byteLength(i.key)>256||/[\x00-\x1f\x7f]/.test(i.key))throw fail('invalid_idempotency','An explicit endpoint idempotency contract, header and bounded key are required');idempotency={header:i.header,key:i.key,contract:true};}
 if(input.lookup!=null){const l=input.lookup;keys(l,['url','recordsPointer','referencePointer'],['url','recordsPointer','referencePointer']);const url=publicUrl(l.url).href;pointer({},l.recordsPointer);pointer({},l.referencePointer);lookup={url,recordsPointer:l.recordsPointer,referencePointer:l.referencePointer};}
 return {destination,reference:input.reference,payload:JSON.parse(encoded),idempotency,lookup};
}
function configuredOrigin(value){if(value===undefined)return null;let u;try{u=new URL(value);}catch{throw Error('PUBLIC_ORIGIN must be one canonical HTTPS origin');}if(u.protocol!=='https:'||u.origin!==value||u.username||u.password||u.hostname.includes('*'))throw Error('PUBLIC_ORIGIN must be one canonical HTTPS origin');return value;}
function origin(request,allowed){const supplied=request.headers.origin;if(supplied===undefined)return null;let u;try{u=new URL(supplied);}catch{throw new ProductError(403,'origin_denied','Origin is not allowed');}const direct=(request.socket.encrypted?'https:':'http:')+'//'+request.headers.host;if(u.origin!==supplied||supplied!==allowed&&supplied!==direct)throw new ProductError(403,'origin_denied','Origin is not allowed');return supplied;}
function json(res,status,value){if(res.destroyed||res.writableEnded)return;const body=JSON.stringify(value);if(Buffer.byteLength(body)>1048576){res.writeHead(413,{...security,'content-type':'application/json'});res.end('{"error":"Export exceeds one MiB; export individual deliveries instead","code":"export_bound"}');return;}res.writeHead(status,{...security,'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body)});res.end(body);}
async function body(req){
 if((req.headers['content-type']??'').split(';')[0].trim()!=='application/json'||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw new ProductError(415,'content_type','Use an uncompressed application/json request');
 if(Number(req.headers['content-length']??0)>32768)throw new ProductError(413,'body_bound','Request body exceeds 32 KiB');
 const raw=await new Promise((resolveBody,reject)=>{let size=0,parts=[],done=false;const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',abort);};const finish=(error)=>{if(done)return;done=true;cleanup();error?reject(error):resolveBody(Buffer.concat(parts).toString('utf8'));};const data=chunk=>{size+=chunk.length;if(size>32768){finish(new ProductError(413,'body_bound','Request body exceeds 32 KiB'));req.resume();}else parts.push(chunk);};const end=()=>finish();const abort=()=>finish(fail('interrupted','Request interrupted'));const timer=setTimeout(()=>{finish(new ProductError(408,'body_timeout','Request body timed out'));req.resume();},2000);req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',abort);});
 try{return JSON.parse(raw);}catch{throw fail('invalid_json','Request body must be valid JSON');}
}
export async function createProductService({dataDir=process.env.DATA_DIR??resolve(ROOT,'.checkpoint-data'),webRoot=join(ROOT,'web'),transport=publicRequest,publicOrigin=process.env.PUBLIC_ORIGIN}={}){
 const allowed=configuredOrigin(publicOrigin),store=new Store(dataDir),active=new Map(),starts=[],workspaceStarts=[];let closing=false,shutdown;
 const rate=(list,max,window=60000)=>{const n=Date.now();while(list.length&&list[0]<=n-window)list.shift();if(list.length>=max)throw new ProductError(429,'rate_limit','Request budget is busy; retry later');list.push(n);};
 const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
  res.on('error',()=>{});req.on('error',()=>{});
  try{
   const path=(req.url??'/').split('?')[0];
   if(path.startsWith('/api/')||path==='/healthz'||path==='/readyz'){
    res.setHeader('vary','Origin');const permitted=origin(req,allowed);if(permitted)res.setHeader('access-control-allow-origin',permitted);
    if(req.method==='OPTIONS'){const requested=(req.headers['access-control-request-headers']??'').split(',').filter(Boolean).map(h=>h.trim().toLowerCase());if(!permitted||requested.some(h=>!['authorization','content-type'].includes(h)))throw new ProductError(403,'origin_denied','Preflight is not allowed');res.writeHead(204,{...security,'access-control-allow-methods':'GET, POST, DELETE','access-control-allow-headers':'Authorization, Content-Type'});res.end();return;}
    if(req.method==='GET'&&['/api/health','/healthz'].includes(path))return json(res,200,{status:'ok',product:'checkpoint-private-delivery'});
    if(req.method==='GET'&&['/api/ready','/readyz'].includes(path))return json(res,closing?503:200,{ready:!closing,durableStorage:true,runtimeUid:process.getuid?.()??null,capacity:LIMITS.concurrency});
    if(closing)throw new ProductError(503,'shutdown','Service is shutting down');
    if(path==='/api/workspaces'&&req.method==='POST'){keys(await body(req),[]);rate(workspaceStarts,5);return json(res,201,store.createWorkspace());}
    const auth=req.headers.authorization;const owner=store.authorize(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):null);
    if(path==='/api/deliveries'&&req.method==='GET')return json(res,200,{deliveries:store.list(owner),limits:LIMITS});
    if(path==='/api/export'&&req.method==='GET')return json(res,200,store.export(owner));
    if(path==='/api/deliveries'&&req.method==='POST'){const config=configuration(await body(req));rate(starts,LIMITS.runsPerMinute);return json(res,201,{delivery:store.create(owner,config)});}
    const match=path.match(/^\/api\/deliveries\/([a-f0-9-]{36})(?:\/(send|retry|reconcile))?$/);
    if(!match)throw new ProductError(404,'not_found','API route not found');const [,id,action]=match;
    if(!action&&req.method==='GET')return json(res,200,{delivery:store.detail(owner,id)});
    if(!action&&req.method==='DELETE'){store.remove(owner,id);res.writeHead(204,security);res.end();return;}
    if(!action||req.method!=='POST')throw new ProductError(405,'method','Unsupported request method');
    const input=await body(req);keys(input,['credential','riskConfirmed']);if(input.riskConfirmed!==undefined&&typeof input.riskConfirmed!=='boolean')throw fail('invalid_confirmation','riskConfirmed must be a boolean');const secret=credential(input.credential);
    const existing=store.detail(owner,id);if(secret&&existing.idempotency?.header.toLowerCase()===secret.name.toLowerCase())throw fail('header_conflict','Credential and idempotency header names must differ');
    if(active.size>=LIMITS.concurrency)throw new ProductError(429,'busy','Two delivery operations are already active');rate(starts,LIMITS.runsPerMinute);
    const kind=action==='reconcile'?'lookup':action,claim=store.claim(owner,id,kind,{riskConfirmed:input.riskConfirmed===true}),controller=new AbortController();
    const disconnect=()=>{if(!res.writableFinished)controller.abort();};res.once('close',disconnect);
    const operation=(async()=>{
     let result;try{
      const c=claim.configuration,headers={};if(secret)headers[secret.name]=secret.value;
      if(kind!=='lookup'){headers['Content-Type']='application/json';headers['X-Checkpoint-Reference']=c.reference;if(c.idempotency)headers[c.idempotency.header]=c.idempotency.key;}
      const raw=await transport(kind==='lookup'?c.lookup.url:c.destination,{method:kind==='lookup'?'GET':'POST',body:kind==='lookup'?undefined:JSON.stringify(c.payload),headers,signal:controller.signal});
      const preview=raw.rawBody?redactedPreview(raw.rawBody,secret?.value):raw.bodyPreview??'';
      if(kind==='lookup'){
       const evidence=raw.httpStatus>=200&&raw.httpStatus<300&&raw.rawBody?lookupProof(raw.rawBody,c.lookup,c.reference):null;
       result={state:evidence?'delivered':'needs_review',httpStatus:raw.httpStatus,responseBytes:raw.responseBytes,bodyPreview:preview,safeRetry:false,evidence,reason:evidence?'Configured lookup returned exactly one receipt matching this reference':'Lookup did not prove one unique matching receipt; absence never authorizes another POST'};
      }else result={...raw,bodyPreview:preview};
     }catch{result={state:'unknown',safeRetry:false,reason:'Operation ended without a complete durable outcome; no automatic retry',bodyPreview:'',responseBytes:0};}
     return store.finish(owner,id,claim.attemptId,result);
    })();active.set(id,{operation,controller});
    try{return json(res,200,{delivery:await operation});}finally{res.off('close',disconnect);active.delete(id);}
   }
   if(!['GET','HEAD'].includes(req.method))throw new ProductError(405,'method','GET required');let decoded;try{decoded=decodeURIComponent(path);}catch{throw fail('path','Invalid path');}
   if(!decoded.startsWith('/')||/[\\\0%]/.test(decoded)||decoded.split('/').some(p=>['.','..'].includes(p)))throw fail('path','Invalid path');
   let actual,base;try{actual=await realpath(resolve(webRoot,'.'+(decoded==='/'?'/index.html':decoded)));base=await realpath(webRoot);}catch{throw new ProductError(404,'not_found','File not found');}
   const rel=relative(base,actual);if(!rel||rel==='..'||rel.startsWith('..'+sep)||!(await stat(actual)).isFile())throw new ProductError(404,'not_found','File not found');const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[extname(actual)];if(!type)throw new ProductError(404,'not_found','File not found');const bytes=await readFile(actual);res.writeHead(200,{...security,'content-type':type,'content-length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){if(error?.status===429)res.setHeader('retry-after','60');json(res,error instanceof ProductError?error.status:500,{error:error instanceof ProductError?error.message:'Request could not be completed',code:error instanceof ProductError?error.code:'internal_error'});}
 });
 server.headersTimeout=3000;server.requestTimeout=4000;server.keepAliveTimeout=1000;server.maxConnections=64;server.maxRequestsPerSocket=100;server.setTimeout(10000,s=>s.destroy());
 return {server,store,stats:()=>({active:active.size}),listen:(port=3000,host='0.0.0.0')=>new Promise((r,j)=>{server.once('error',j);server.listen(port,host,()=>r(server.address()));}),close(){return shutdown??=(async()=>{closing=true;const drained=new Promise(r=>server.close(r));server.closeIdleConnections();const timer=setTimeout(()=>{for(const {controller}of active.values())controller.abort();server.closeAllConnections();},7000);timer.unref();await drained;await Promise.allSettled([...active.values()].map(v=>v.operation));clearTimeout(timer);store.close();})()}};
}
