/** Public HTTPS only. All DNS answers are checked and the selected address is pinned. */
import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {ProductError,LIMITS} from './store.mjs';
const denied=(message='Destination must be a public HTTPS URL on port 443')=>new ProductError(400,'unsafe_destination',message);
export function publicUrl(value){
 if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f]/.test(value))throw denied();let u;try{u=new URL(value);}catch{throw denied();}
 if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||!u.hostname||u.hostname.includes('%'))throw denied();
 const host=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.test')||host.endsWith('.invalid')||host.endsWith('.example')||host==='metadata.google.internal')throw denied();
 if(isIP(host)&&!publicAddress(host))throw denied();return u;
}
export function publicAddress(address){
 const family=isIP(address);if(family===4){const a=address.split('.').map(Number);const [x,y,z]=a;
  return !(x===0||x===10||x===127||x>=224||x===100&&y>=64&&y<=127||x===168&&y===63&&z===129&&a[3]===16||x===169&&y===254||x===172&&y>=16&&y<=31||x===192&&(y===168||y===0||y===88&&z===99)||x===198&&(y===18||y===19||y===51&&z===100)||x===203&&y===0&&z===113);
 }
 if(family===6){
  // Conservative global-unicast allowlist excludes mapped, translated and tunneled IPv4.
  const s=address.toLowerCase();if(s.includes('.')||s.includes('%'))return false;
  const halves=s.split('::');if(halves.length>2)return false;const left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
  const groups=[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right].map(x=>parseInt(x,16));
  const [a,b]=groups;return a>=0x2000&&a<=0x3fff&&a!==0x2002&&a!==0x3ffe&&!(a===0x3fff&&b<0x1000)&&!(a===0x2001&&b<0x0200)&&!(a===0x2001&&b===0x0db8);
 }
 return false;
}
export async function pinDestination(value,{resolver=dnsLookup}={}){
 const u=publicUrl(value),host=u.hostname.replace(/^\[|\]$/g,'');let rows;
 if(isIP(host))rows=[{address:host,family:isIP(host)}];else{
  let timer;try{rows=await Promise.race([resolver(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(denied('Destination DNS resolution timed out')),1500);})]);}catch(error){if(error instanceof ProductError)throw error;throw denied('Destination DNS resolution failed');}finally{clearTimeout(timer);}
 }
 if(!Array.isArray(rows)||!rows.length||rows.length>16||rows.some(r=>!publicAddress(r.address)||r.family!==isIP(r.address)))throw denied('Every DNS answer must be a public unicast address');
 return {url:u,host,address:rows[0].address,family:rows[0].family};
}
export function redactedPreview(bytes,secret){
 if(secret)return '[Response body omitted because a credential was supplied; '+bytes.length+' bytes received]';
 let text=bytes.toString('utf8');
 try{const value=JSON.parse(text);const clean=(v,depth=0)=>{if(depth>8)return '[TRUNCATED]';if(Array.isArray(v))return v.slice(0,20).map(x=>clean(x,depth+1));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).slice(0,30).map(([k,x])=>[k,/authorization|cookie|token|secret|password|api.?key|credential/i.test(k)?'[REDACTED]':clean(x,depth+1)]));return v;};text=JSON.stringify(clean(value));}catch{text=text.replace(/(?:bearer|basic)\s+[^\s"<>,]+/gi,'[REDACTED]').replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s<>,]+/gi,'$1[REDACTED]');}
 return text.slice(0,1024);
}
export async function publicRequest(value,{method='GET',body,headers={},signal,timeoutMs=5000,resolver,requestImpl=https.request}={}){
 let pin;try{pin=await pinDestination(value,{resolver});}catch{return {state:'failed',safeRetry:true,reason:'Request blocked before transmission: destination URL or DNS was not safely public',responseBytes:0,bodyPreview:''};}
 if(signal?.aborted)return {state:'unknown',reason:'Operation interrupted; no retry was scheduled',responseBytes:0,bodyPreview:''};
 return await new Promise(resolve=>{
  let finished=false,connected=false,size=0,chunks=[],request,timer;
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(result);};
  const uncertain=reason=>{request?.destroy();finish({state:'unknown',reason,responseBytes:size,bodyPreview:''});};
  const abort=()=>uncertain('Operation interrupted; remote outcome unknown');
  const options={protocol:'https:',hostname:pin.host,port:443,path:pin.url.pathname+pin.url.search,method,headers,agent:false,servername:isIP(pin.host)?undefined:pin.host,rejectUnauthorized:true,lookup:(_host,opts,callback)=>opts?.all?callback(null,[{address:pin.address,family:pin.family}]):callback(null,pin.address,pin.family)};
  try{request=requestImpl(options,response=>{
   connected=true;
   response.on('data',chunk=>{size+=chunk.length;if(size>LIMITS.responseBytes){response.destroy();uncertain('Response exceeded the 32 KiB bound; remote outcome remains unknown');}else chunks.push(chunk);});
   response.on('end',()=>finish({state:method==='POST'&&response.statusCode>=200&&response.statusCode<300?'delivered':'unknown',httpStatus:response.statusCode,responseBytes:size,rawBody:Buffer.concat(chunks),reason:method==='POST'&&response.statusCode>=200&&response.statusCode<300?'Destination returned a successful HTTP acknowledgement; business completion is not independently proven':'HTTP response does not prove the operation was uncommitted; no automatic retry'}));
   response.on('aborted',()=>uncertain('Response ended before its full acknowledgement was received'));
   response.on('error',()=>uncertain('Response could not be completely read; outcome unknown'));
  });
  request.on('socket',socket=>{socket.once('secureConnect',()=>{connected=true;const actual=socket.remoteAddress?.replace(/^::ffff:/,'');if(actual!==pin.address&&socket.remoteAddress!==pin.address)uncertain('Connected address did not match the validated DNS pin');});});
  request.on('error',()=>finish({state:connected?'unknown':'failed',safeRetry:!connected,reason:connected?'Connection failed after transmission may have begun; outcome unknown':'Connection failed before a verified TLS session; HTTP request was not sent',responseBytes:size,bodyPreview:''}));
  timer=setTimeout(()=>uncertain('Network time budget exhausted; remote outcome unknown'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();request.end(body);
  }catch{finish({state:'failed',safeRetry:true,reason:'Request could not be constructed before transmission',responseBytes:0,bodyPreview:''});}
 });
}
export function pointer(value,path){if(typeof path!=='string'||path.length>128||path!==''&&!path.startsWith('/')||/~(?:[^01]|$)/.test(path))throw new ProductError(400,'invalid_pointer','Use an RFC 6901 JSON pointer');let current=value;const keys=path===''?[]:path.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'));if(keys.length>8)throw new ProductError(400,'invalid_pointer','JSON pointer depth exceeds eight');for(const key of keys){if(!current||typeof current!=='object'||!Object.hasOwn(current,key))return undefined;current=current[key];}return current;}
export function lookupProof(bytes,lookup,reference){
 let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{return null;}
 const records=pointer(parsed,lookup.recordsPointer);if(!Array.isArray(records)||records.length>100)return null;
 let matches=[];for(const record of records){if(!record||typeof record!=='object'||Array.isArray(record))return null;const found=pointer(record,lookup.referencePointer);if(typeof found!=='string')return null;if(found===reference)matches.push(record);}
 if(matches.length!==1)return null;return {kind:'unique_reference_lookup',reference,receiptDigest:createHash('sha256').update(JSON.stringify(matches[0])).digest('hex'),observedAt:new Date().toISOString(),notice:'Configured receipt source returned one exact reference match; this depends on that source’s identity and uniqueness contract'};
}
