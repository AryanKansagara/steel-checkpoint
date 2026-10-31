/** Initialize only the trusted data directory, then irrevocably drop before server import. */
import {mkdir,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=process.env.DATA_DIR??resolve(root,'.checkpoint-data');
if(!directory.startsWith('/')||resolve(directory)!==directory)throw Error('DATA_DIR must be canonical and absolute');
if(process.getuid?.()===0){
 if(process.env.DROP_PRIVILEGES!=='1')throw Error('Root startup requires explicit DROP_PRIVILEGES=1');
 if(directory!=='/data/checkpoint'&&!(process.env.NODE_ENV!=='production'&&directory===resolve(root,'.checkpoint-data')))throw Error('Root launcher only initializes the trusted Checkpoint data directory');
 let prefix=parse(directory).root;for(const part of directory.slice(prefix.length).split('/')){prefix=resolve(prefix,part);try{if((await lstat(prefix)).isSymbolicLink())throw Error('DATA_DIR ancestry must not contain symlinks');}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(directory==='/data/checkpoint'){const parent=await open('/data',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.chmod(0o711);}finally{await parent.close();}}
 await mkdir(directory,{recursive:true,mode:0o700});const handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.chown(1000,1000);await handle.chmod(0o700);}finally{await handle.close();}
 process.setgroups([]);process.setgid(1000);process.setuid(1000);if(process.getuid()!==1000||process.getgid()!==1000)throw Error('Privilege drop failed');
}else if(process.env.DROP_PRIVILEGES==='1')throw Error('DROP_PRIVILEGES root launch was requested without root');
process.env.DATA_DIR=directory;const {startMain}=await import('../server.mjs');await startMain();
