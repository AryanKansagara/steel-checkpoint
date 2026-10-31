/** Durable private intent ledger. Credentials and bearer tokens never enter SQLite. */
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,lstatSync,chmodSync,accessSync,constants,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
export class ProductError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export const LIMITS={payloadBytes:16384,responseBytes:32768,workspaceDeliveries:50,globalDeliveries:500,workspaces:500,attempts:20,retentionDays:7,concurrency:2,runsPerMinute:20};
const hash=token=>createHash('sha256').update(token).digest('hex');
const now=()=>new Date().toISOString();
const processStamp=pid=>{try{const s=readFileSync('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19];}catch{return null;}};
const alive=(pid,stamp)=>{try{process.kill(pid,0);const current=processStamp(pid);return !current||!stamp||current===stamp;}catch(error){return error.code!=='ESRCH';}};
export class Store {
 constructor(directory){
  if(typeof directory!=='string'||!directory||!directory.startsWith('/')||resolve(directory)!==directory)throw Error('DATA_DIR must be a canonical absolute directory');
  mkdirSync(directory,{recursive:true,mode:0o700});if(lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory())throw Error('DATA_DIR must be a real directory');
  accessSync(directory,constants.R_OK|constants.W_OK|constants.X_OK);chmodSync(directory,0o700);
  const path=join(directory,'workspace.sqlite');
  try{if(lstatSync(path).isSymbolicLink())throw Error('Database symlinks are prohibited');}catch(error){if(error.code!=='ENOENT')throw error;}
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA max_page_count=16384; PRAGMA journal_size_limit=4194304; PRAGMA wal_autocheckpoint=256;
   BEGIN IMMEDIATE;
   CREATE TABLE IF NOT EXISTS service_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,stamp TEXT,nonce TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS workspaces(token_hash TEXT PRIMARY KEY,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,workspace_hash TEXT NOT NULL REFERENCES workspaces(token_hash) ON DELETE CASCADE,reference TEXT NOT NULL,configuration TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,safe_retry INTEGER NOT NULL DEFAULT 0,evidence TEXT,UNIQUE(workspace_hash,reference));
   CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,kind TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,http_status INTEGER,reason TEXT NOT NULL DEFAULT '',response_bytes INTEGER NOT NULL DEFAULT 0,body_preview TEXT NOT NULL DEFAULT '',evidence TEXT);
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,state TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS delivery_owner ON deliveries(workspace_hash,created_at);
   COMMIT;`);chmodSync(path,0o600);
  this.nonce=randomUUID();try{this.transaction(()=>{const owner=this.db.prepare('SELECT * FROM service_owner WHERE singleton=1').get();if(owner&&alive(owner.pid,owner.stamp))throw Error('DATA_DIR already has a live service owner');this.db.prepare('INSERT OR REPLACE INTO service_owner VALUES (1,?,?,?)').run(process.pid,processStamp(process.pid),this.nonce);});}catch(error){this.db.close();throw error;}
  // A process restart cannot infer what a remote endpoint committed.
  this.transaction(()=>{
   const interrupted=this.db.prepare("SELECT id FROM deliveries WHERE state='delivering'").all();
   for(const row of interrupted){this.db.prepare("UPDATE attempts SET status='unknown',finished_at=?,reason='Process restarted before outcome was durably recorded' WHERE delivery_id=? AND finished_at IS NULL").run(now(),row.id);this.transition(row.id,'unknown','Process restarted; remote outcome unknown; no automatic retry',false);}
  });this.prune();
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 prune(){const time=now();this.db.prepare('DELETE FROM workspaces WHERE expires_at<?').run(time);}
 createWorkspace(){this.prune();if(this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n>=LIMITS.workspaces)throw new ProductError(429,'workspace_capacity','Workspace capacity reached; try later');const token=randomBytes(32).toString('base64url'),createdAt=now(),expiresAt=new Date(Date.now()+LIMITS.retentionDays*86400000).toISOString();this.db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(hash(token),createdAt,expiresAt);return {token,workspace:{createdAt,expiresAt},limits:LIMITS};}
 authorize(token){this.prune();if(typeof token!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(token))throw new ProductError(401,'unauthorized','A valid workspace token is required');const digest=hash(token),workspace=this.db.prepare('SELECT * FROM workspaces WHERE token_hash=? AND expires_at>?').get(digest,now());if(!workspace)throw new ProductError(401,'unauthorized','A valid workspace token is required');return digest;}
 require(owner,id){const row=this.db.prepare('SELECT * FROM deliveries WHERE id=? AND workspace_hash=?').get(id,owner);if(!row)throw new ProductError(404,'not_found','Delivery not found');return row;}
 transition(id,state,reason,safe=false,evidence=null){const at=now();this.db.prepare('UPDATE deliveries SET state=?,updated_at=?,safe_retry=?,evidence=COALESCE(?,evidence) WHERE id=?').run(state,at,Number(safe),evidence?JSON.stringify(evidence):null,id);this.db.prepare('INSERT INTO events(delivery_id,state,at,reason) VALUES (?,?,?,?)').run(id,state,at,reason);}
 create(owner,configuration){return this.transaction(()=>{
  this.prune();if(this.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n>=LIMITS.globalDeliveries||this.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE workspace_hash=?').get(owner).n>=LIMITS.workspaceDeliveries)throw new ProductError(429,'history_capacity','History capacity reached; export and delete old deliveries');
  if(this.db.prepare('SELECT 1 FROM deliveries WHERE workspace_hash=? AND reference=?').get(owner,configuration.reference))throw new ProductError(409,'reference_exists','This workspace already has that reference');
  const id=randomUUID(),at=now();this.db.prepare('INSERT INTO deliveries(id,workspace_hash,reference,configuration,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,owner,configuration.reference,JSON.stringify(configuration),'queued',at,at);this.transition(id,'queued','Intent persisted; no request has been sent');return this.detail(owner,id);
 });}
 summary(row){const configuration=JSON.parse(row.configuration);return {id:row.id,reference:row.reference,destination:configuration.destination,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,attemptCount:this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE delivery_id=?').get(row.id).n,canRetrySafely:!['queued','delivering','delivered'].includes(row.state)&&Boolean(row.safe_retry||configuration.idempotency?.contract),hasLookup:Boolean(configuration.lookup)};}
 list(owner){return this.db.prepare('SELECT * FROM deliveries WHERE workspace_hash=? ORDER BY created_at DESC,id').all(owner).map(row=>this.summary(row));}
 detail(owner,id){const row=this.require(owner,id),configuration=JSON.parse(row.configuration);return {...this.summary(row),...configuration,hasCredentials:false,evidence:row.evidence?JSON.parse(row.evidence):null,attempts:this.db.prepare('SELECT * FROM attempts WHERE delivery_id=? ORDER BY rowid').all(id).map(a=>({id:a.id,kind:a.kind,startedAt:a.started_at,finishedAt:a.finished_at,status:a.status,httpStatus:a.http_status,reason:a.reason,responseBytes:a.response_bytes,bodyPreview:a.body_preview,evidence:a.evidence?JSON.parse(a.evidence):null})),events:this.db.prepare('SELECT state,at,reason FROM events WHERE delivery_id=? ORDER BY id').all(id)};}
 claim(owner,id,kind,{riskConfirmed=false}={}){const claimed=this.transaction(()=>{
  const row=this.require(owner,id),configuration=JSON.parse(row.configuration);
  if(row.state==='delivering')throw new ProductError(409,'busy','This delivery already has an active operation');
  if(row.state==='delivered')throw new ProductError(409,'already_delivered','An acknowledged delivery cannot be sent again');
  if(this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE delivery_id=?').get(id).n>=LIMITS.attempts)throw new ProductError(429,'attempt_budget','Delivery attempt budget exhausted');
  if(kind==='lookup'){if(!configuration.lookup||!['unknown','needs_review','failed'].includes(row.state))throw new ProductError(409,'lookup_unavailable','Only an uncertain delivery with configured lookup can be reconciled');}
  else if(kind==='send'){if(row.state!=='queued')throw new ProductError(409,'not_queued','Use an explicit retry decision for a previously attempted delivery');}
  else if(kind==='retry'){
   if(row.state==='queued')throw new ProductError(409,'not_attempted','Send the queued delivery first');
   if(!row.safe_retry&&!configuration.idempotency?.contract&&!riskConfirmed){this.transition(id,'needs_review','No safe retry evidence; explicit duplicate-risk confirmation is required');return {riskBlocked:true};}
  }else throw Error('unsupported operation');
  const attemptId=randomUUID(),startedAt=now();this.db.prepare('INSERT INTO attempts(id,delivery_id,kind,started_at,status) VALUES (?,?,?,?,?)').run(attemptId,id,kind==='lookup'?'lookup':'post',startedAt,'delivering');
  this.transition(id,'delivering',kind==='lookup'?'Read-only receipt lookup started':kind==='retry'&&riskConfirmed&&!configuration.idempotency?.contract&&!row.safe_retry?'User explicitly confirmed duplicate risk before another POST':'Delivery intent committed before real POST');return {attemptId,configuration};
 });if(claimed.riskBlocked)throw new ProductError(409,'risk_confirmation_required','Outcome unknown. Reconcile or explicitly confirm duplicate risk.');return claimed;}
 finish(owner,id,attemptId,result){return this.transaction(()=>{
  this.require(owner,id);this.db.prepare('UPDATE attempts SET finished_at=?,status=?,http_status=?,reason=?,response_bytes=?,body_preview=?,evidence=? WHERE id=? AND delivery_id=?').run(now(),result.state,result.httpStatus??null,result.reason,result.responseBytes??0,result.bodyPreview??'',result.evidence?JSON.stringify(result.evidence):null,attemptId,id);
  this.transition(id,result.state,result.reason,result.safeRetry===true,result.evidence??null);return this.detail(owner,id);
 });}
 remove(owner,id){return this.transaction(()=>{const row=this.require(owner,id);if(row.state==='delivering')throw new ProductError(409,'busy','An active delivery cannot be deleted');this.db.prepare('DELETE FROM deliveries WHERE id=? AND workspace_hash=?').run(id,owner);});}
 export(owner){return {schemaVersion:1,exportedAt:now(),notice:'Private delivery history. No workspace bearer token or credential header values are included.',deliveries:this.list(owner).map(item=>this.detail(owner,item.id))};}
 close(){this.db.prepare('DELETE FROM service_owner WHERE singleton=1 AND nonce=?').run(this.nonce);this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();}
}
