/** Bounded same-origin HTTP service. Python owns the actual recovery experiment. */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,realpath,stat} from 'node:fs/promises';
import {join,resolve,relative,extname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
const ROOT=fileURLToPath(new URL('.',import.meta.url));
const MAX_BODY=16384,MAX_OUTPUT=262144;
const security={
 'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
 'cache-control':'no-store',
};
export class RequestError extends Error {constructor(status,message){super(message);this.status=status;}}
/** Flat JSON schema parser rejects duplicate keys, even escaped equivalent keys. */
export function parseConfig(raw) {
 try{JSON.parse(raw);}catch{throw new RequestError(400,'Invalid JSON configuration');}
 let input=raw.trim(),cursor=0;const result={},seen=new Set();
 const ws=()=>{while(/\s/.test(input[cursor]??'')&&cursor<input.length)cursor++;};
 const value=()=>{
  ws();const match=input.slice(cursor).match(/^("(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
  if(!match)throw new RequestError(400,'Expected a flat JSON configuration');cursor+=match[0].length;return JSON.parse(match[0]);
 };
 if(input[cursor++]!=='{')throw new RequestError(400,'Expected a JSON object');ws();
 if(input[cursor]!=='}')while(true){
  const key=value();if(typeof key!=='string'||seen.has(key))throw new RequestError(400,'Duplicate or invalid configuration key');seen.add(key);ws();
  if(input[cursor++]!==':')throw new RequestError(400,'Invalid JSON configuration');const item=value();Object.defineProperty(result,key,{value:item,enumerable:true});ws();
  if(input[cursor]===','){cursor++;continue;}break;
 }
 if(input[cursor++]!=='}')throw new RequestError(400,'Invalid JSON configuration');ws();if(cursor!==input.length)throw new RequestError(400,'Trailing JSON content');
 const keys=Object.keys(result);
 if(keys.length!==3||!['mode','fault','visibilityDelayMs'].every(k=>seen.has(k))||!['observable','opaque','idempotent'].includes(result.mode)||!['none','before_commit','after_commit'].includes(result.fault)||!Number.isInteger(result.visibilityDelayMs)||result.visibilityDelayMs<0||result.visibilityDelayMs>300)throw new RequestError(400,'Use mode, fault and integer visibilityDelayMs (0..300) only');
 return result;
}
function json(response,status,body,extra={}){
 if(response.destroyed||response.writableEnded)return;
 const bytes=JSON.stringify(body);response.writeHead(status,{...security,'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(bytes),...extra});response.end(bytes);
}
function readBody(request){
 return new Promise((resolveBody,reject)=>{
  const chunks=[];let size=0,done=false;
  const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('aborted',aborted);request.off('error',aborted);if(error)reject(error);else resolveBody(Buffer.concat(chunks).toString('utf8'));};
  const data=chunk=>{size+=chunk.length;if(size>MAX_BODY){finish(new RequestError(413,'Body exceeds 16 KiB'));request.resume();}else chunks.push(chunk);};
  const end=()=>finish();const aborted=()=>finish(new RequestError(400,'Request interrupted'));
  const timer=setTimeout(()=>{finish(new RequestError(408,'Request body timed out'));request.resume();},2000);
  request.on('data',data);request.once('end',end);request.once('aborted',aborted);request.once('error',aborted);
 });
}
const killGroup=(child,signal)=>{if(!Number.isInteger(child?.pid)||child.pid<=0)return;try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
export async function runWorker(config,{signal,timeoutMs=6000,onSpawn=()=>{},spawnProcess=spawn}={}) {
 const directory=await mkdtemp(join(tmpdir(),'checkpoint-run-'));
 let child,killTimer;
 try {
  if(signal?.aborted)throw new RequestError(499,'Client disconnected');
  return await new Promise((resolveWorker,reject)=>{
   child=spawnProcess('python3',['-m','checkpoint.service_worker'],{cwd:ROOT,env:{...process.env,CHECKPOINT_RUN_DIR:directory,TMPDIR:directory,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe'],detached:true});onSpawn(child);
   let bytes=0,output=[],failure=null;
   const cancel=(error)=>{if(failure)return;failure=error;killGroup(child,'SIGTERM');killTimer=setTimeout(()=>killGroup(child,'SIGKILL'),250);};
   const timeout=setTimeout(()=>cancel(new RequestError(504,'Experiment exceeded its time budget')),timeoutMs);
   const abort=()=>cancel(new RequestError(499,'Client disconnected'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT)cancel(new RequestError(502,'Invalid experiment response'));else output.push(chunk);});
   child.stderr.resume(); // Never return local paths, environment or tracebacks to callers.
   child.stdin.on('error',()=>{});
   child.once('error',()=>{failure=new RequestError(503,'Experiment worker unavailable');});
   child.once('close',code=>{
    clearTimeout(timeout);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
    if(failure)return reject(failure);
    if(code!==0)return reject(new RequestError(503,'Experiment could not complete'));
    try{
     const result=JSON.parse(Buffer.concat(output).toString('utf8'));
     if(!result?.runId||!result.naive||!result.reconcile||!result.summary)throw Error();resolveWorker(result);
    }catch{reject(new RequestError(502,'Invalid experiment response'));}
   });
   child.stdin.end(JSON.stringify(config));
  });
 }finally{clearTimeout(killTimer);await rm(directory,{recursive:true,force:true});}
}
export async function createService({webRoot=join(ROOT,'web'),capacity=2,rateLimit=20,rateWindowMs=60000,worker=runWorker}={}) {
 if(!Number.isInteger(capacity)||capacity<1||capacity>2||!Number.isInteger(rateLimit)||rateLimit<1||!Number.isFinite(rateWindowMs)||rateWindowMs<=0)throw Error('invalid service limits');
 let closing=false,ready=false;const active=new Set(),children=new Set(),jobs=new Set(),starts=[];
 // Readiness checks the fixed Python executable and existing recovery modules.
 await new Promise((resolveReady,reject)=>{
  const probe=spawn('python3',['-c','import checkpoint.engine, checkpoint.fixture, checkpoint.service_worker'],{cwd:ROOT,stdio:'ignore'});
  const timer=setTimeout(()=>{probe.kill('SIGKILL');reject(Error('Python readiness timed out'));},2000);
  probe.once('error',()=>{clearTimeout(timer);reject(Error('Python runtime unavailable'));});probe.once('close',code=>{clearTimeout(timer);code===0?resolveReady():reject(Error('Python recovery modules unavailable'));});
 });ready=true;
 const server=http.createServer({maxHeaderSize:8192},async(request,response)=>{
  response.on('error',()=>{});
  try {
   const raw=request.url??'/';const pathOnly=raw.split('?')[0];
   if(pathOnly==='/api/health'&&request.method==='GET')return json(response,200,{status:'ok',service:'checkpoint'});
   if(pathOnly==='/api/ready'&&request.method==='GET'){const frontendReady=await stat(join(webRoot,'index.html')).then(file=>file.isFile()).catch(()=>false);return json(response,ready&&!closing&&frontendReady?200:503,{ready:ready&&!closing&&frontendReady,checks:{python:ready,frontend:frontendReady},active:active.size,capacity});}
   if(pathOnly==='/api/run'){
    if(request.method!=='POST')return json(response,405,{error:'POST required'},{allow:'POST'});
    if(closing)return json(response,503,{error:'Service is shutting down'});
    if((request.headers['content-type']??'').split(';')[0].trim()!=='application/json')return json(response,415,{error:'application/json required'});
    if(request.headers['content-encoding']&&request.headers['content-encoding']!=='identity')return json(response,415,{error:'Compressed bodies are unsupported'});
    const declared=request.headers['content-length'];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))return json(response,413,{error:'Body exceeds 16 KiB'});
    const config=parseConfig(await readBody(request));
    if(request.aborted||response.destroyed)return;
    if(closing)return json(response,503,{error:'Service is shutting down'});
    const now=Date.now();while(starts.length&&starts[0]<=now-rateWindowMs)starts.shift();
    if(active.size>=capacity||starts.length>=rateLimit){const retry=active.size>=capacity?1:Math.max(1,Math.ceil((starts[0]+rateWindowMs-now)/1000));return json(response,429,{error:'Experiment capacity is busy; retry later',retryAfterMs:retry*1000},{'retry-after':String(retry)});}
    const controller=new AbortController();active.add(controller);starts.push(now);
    const interrupted=()=>{if(!response.writableFinished)controller.abort();};response.once('close',interrupted);
    let job;
    try {job=Promise.resolve().then(()=>worker(config,{signal:controller.signal,onSpawn:child=>{children.add(child);child.once('close',()=>children.delete(child));}}));jobs.add(job);const result=await job;json(response,200,result);}
    finally{jobs.delete(job);response.off('close',interrupted);active.delete(controller);}
    return;
   }
   if(pathOnly.startsWith('/api/'))return json(response,404,{error:'API route not found'});
   if(!['GET','HEAD'].includes(request.method))return json(response,405,{error:'GET required'},{allow:'GET, HEAD'});
   let decoded;try{decoded=decodeURIComponent(pathOnly);}catch{throw new RequestError(400,'Invalid path');}
   if(!decoded.startsWith('/')||decoded.includes('\\')||decoded.includes('\0')||decoded.includes('%')||decoded.split('/').some(p=>p==='.'||p==='..'))throw new RequestError(400,'Invalid path');
   const candidate=resolve(webRoot,'.'+(decoded==='/'?'/index.html':decoded));
   let actual;try{actual=await realpath(candidate);}catch{return json(response,404,{error:'File not found'});}
   const base=await realpath(webRoot);const relativePath=relative(base,actual);
   if(relativePath==='..'||relativePath.startsWith('..'+sep)||!relativePath||!(await stat(actual)).isFile())return json(response,404,{error:'File not found'});
   const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'}[extname(actual)];
   if(!mime)return json(response,404,{error:'File not found'});
   const bytes=await readFile(actual);response.writeHead(200,{...security,'content-type':mime,'content-length':bytes.length});response.end(request.method==='HEAD'?undefined:bytes);
  }catch(error){json(response,error instanceof RequestError?error.status:500,{error:error instanceof RequestError?error.message:'Request could not complete'});}
 });
 server.headersTimeout=3000;server.requestTimeout=4000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=100;server.maxConnections=64;server.setTimeout(9000,socket=>socket.destroy());
 let shutdown;
 return {server,listen:(port=3000,host='0.0.0.0')=>new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolveListen(server.address()));}),
  close(){return shutdown??=(async()=>{closing=true;ready=false;const drained=new Promise(resolveClose=>server.close(resolveClose));server.closeIdleConnections();const timer=setTimeout(()=>{for(const controller of active)controller.abort();for(const child of children)killGroup(child,'SIGTERM');server.closeAllConnections();},7000);timer.unref();await drained;await Promise.allSettled([...jobs]);clearTimeout(timer);})()},
  stats:()=>({active:active.size,rateEntries:starts.length,children:children.size})};
}
export function startOptions(args=[],environment=process.env){
 const {values}=parseArgs({args,allowPositionals:false,options:{host:{type:'string',default:'0.0.0.0'},port:{type:'string'},strictPort:{type:'boolean',default:false}}});
 const port=values.port??environment.PORT??'3000';
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('PORT must be 1..65535');
 if(!['0.0.0.0','127.0.0.1','localhost','::1'].includes(values.host))throw Error('unsupported bind host');
 return {port:Number(port),host:values.host}; // Binding is always strict: never select a fallback port.
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {port,host}=startOptions(process.argv.slice(2));
 const service=await createService();await service.listen(port,host);console.log(`Checkpoint listening on ${host}:${port}`);
 let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;await service.close();process.exitCode=0;});
}
