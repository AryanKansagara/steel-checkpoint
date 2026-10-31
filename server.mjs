/** Private durable webhook delivery product entrypoint. Legacy fixture server is separate. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
export {createProductService,createProductService as createService} from './product/service.mjs';
export function startOptions(args=[],environment=process.env){const {values}=parseArgs({args,allowPositionals:false,options:{host:{type:'string',default:'0.0.0.0'},port:{type:'string'},strictPort:{type:'boolean',default:false}}});const port=values.port??environment.PORT??'3000';if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!['0.0.0.0','127.0.0.1','localhost','::1'].includes(values.host))throw Error('Invalid bind host or port');return {host:values.host,port:Number(port)};}
export async function startMain(){if(process.getuid?.()===0)throw Error('Refusing HTTP as root; use the trusted privilege-dropping launcher');const {createProductService}=await import('./product/service.mjs');const service=await createProductService();const {port,host}=startOptions(process.argv.slice(2));await service.listen(port,host);console.log(`Checkpoint private delivery service listening on ${host}:${port}`);let stopping=false;for(const name of ['SIGTERM','SIGINT'])process.on(name,async()=>{if(stopping)return;stopping=true;await service.close();process.exitCode=0;});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await startMain();
