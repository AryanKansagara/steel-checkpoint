import {createService} from '../server.mjs';
const service=await createService();try{
 const address=await service.listen(0,'127.0.0.1'),url=`http://127.0.0.1:${address.port}`;
 if(!(await fetch(url+'/api/ready')).ok)throw Error('readiness failed');
 const response=await fetch(url+'/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'observable',fault:'after_commit',visibilityDelayMs:40})});
 const result=await response.json();if(!response.ok||result.naive.duplicates!==1||result.reconcile.duplicates!==0||result.reconcile.state!=='verified')throw Error('comparison smoke failed');
 console.log(JSON.stringify({status:'pass',naiveDuplicates:result.naive.duplicates,reconcileDuplicates:result.reconcile.duplicates,provenance:result.summary.provenance}));
}finally{await service.close();}
