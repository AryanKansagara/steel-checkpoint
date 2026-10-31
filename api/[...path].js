/** Native Vercel JSON relay: fixed backend, explicit routes, no browser header proxying. */
const BACKEND='https://checkpoint-production-81f4.up.railway.app';
const FRONTEND='https://steel-checkpoint.vercel.app';
export default async function handler(request,response){
 response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
 const error=(status,code,message)=>response.status(status).json({error:message,code});
 let pathname;try{pathname=new URL(request.url,'https://relay.invalid').pathname;}catch{return error(400,'path','Invalid path');}
 if(!/^\/api\/(?:workspaces|deliveries|export|health|ready)$/.test(pathname)&&!/^\/api\/deliveries\/[a-f0-9-]{36}(?:\/(?:send|retry|reconcile))?$/.test(pathname))return error(404,'not_found','API route not found');
 if(!['GET','POST','DELETE'].includes(request.method))return error(405,'method','Unsupported method');
 if(request.headers.origin&&request.headers.origin!==FRONTEND)return error(403,'origin_denied','Origin is not allowed');
 const headers={'Origin':FRONTEND};const auth=request.headers.authorization;if(auth)headers.Authorization=auth;
 let body;
 if(request.method==='POST'){
  if((request.headers['content-type']??'').split(';')[0].trim()!=='application/json')return error(415,'content_type','Use application/json');
  try{const parsed=typeof request.body==='string'?JSON.parse(request.body):request.body;if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();body=JSON.stringify(parsed);if(Buffer.byteLength(body)>32768)return error(413,'body_bound','Request exceeds 32 KiB');}catch{return error(400,'invalid_json','Invalid JSON request');}
  headers['Content-Type']='application/json';
 }
 try{
  const upstream=await fetch(BACKEND+pathname,{method:request.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(9000)});
  if(upstream.status>=300&&upstream.status<400)return error(502,'backend_redirect','Backend redirect refused');
  if(upstream.status===204){response.status(204).end();return;}
  const reader=upstream.body?.getReader();let size=0,parts=[];if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();return error(502,'response_bound','Backend response exceeded limit');}parts.push(Buffer.from(value));}
  let result;try{result=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return error(502,'backend_response','Backend returned invalid JSON');}
  const retry=upstream.headers.get('retry-after');if(retry&&/^\d{1,5}$/.test(retry))response.setHeader('Retry-After',retry);
  response.status(upstream.status).json(result);
 }catch{return error(504,'backend_unavailable','Backend response was interrupted. Refresh private history before another action.');}
}
