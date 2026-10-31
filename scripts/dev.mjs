/** Work Mode/local preview only. Production must use the guarded nonroot launcher. */
if(process.env.NODE_ENV==='production'||process.env.RAILWAY_ENVIRONMENT_ID)throw Error('The development entrypoint is prohibited in production or Railway');
const {createProductService,startOptions}=await import('../server.mjs');
const service=await createProductService();const {port,host}=startOptions(process.argv.slice(2));await service.listen(port,host);console.log(`Checkpoint development preview listening on ${host}:${port}`);
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;await service.close();process.exitCode=0;});
