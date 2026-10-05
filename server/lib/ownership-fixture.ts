/** Test-only fixture: synthetic, Unix socket only. Never imports server/db. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import type { OwnershipDatabase, Transaction } from "./org-context";

const marker="somr432-owned-synthetic-postgres-v1";
const quote=(s:string)=>{assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(s));return '"'+s+'"';};
export function verifyFixture(root:string) {
  assert(/^\/tmp\/somr432-ownership-[A-Za-z0-9]+$/.test(root));
  assert.equal(fs.realpathSync(root),root);
  const st=fs.lstatSync(root);assert(st.isDirectory());assert.equal(st.uid,process.getuid!());assert.equal(st.mode&511,448);
  const mark=fs.lstatSync(root+"/ownership");assert(mark.isFile());assert.equal(mark.uid,process.getuid!());assert.equal(mark.mode&511,384);
  assert.equal(fs.readFileSync(root+"/ownership","utf8"),marker);
  const socket=fs.lstatSync(root+"/socket");assert(socket.isDirectory());assert.equal(socket.uid,process.getuid!());
  assert.equal(socket.mode&511,448);
  assert.equal(fs.realpathSync(root+"/socket"),root+"/socket");
}
export async function connectFixture(root:string) {
  verifyFixture(root); // before constructing a client or attempting any connection
  const c=new Client({host:root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,
    connectionTimeoutMillis:5000,options:"-c statement_timeout=10000 -c lock_timeout=2000"});
  await c.connect();return c;
}
export async function startFixture(label:string) {
  const receipts=process.env.OWNERSHIP_EVIDENCE_DIR;
  const events:unknown[]=[];const start=new Date().toISOString();
  const root=fs.mkdtempSync("/tmp/somr432-ownership-");
  fs.chmodSync(root,0o700);fs.writeFileSync(root+"/ownership",marker,{mode:0o600});
  fs.mkdirSync(root+"/socket",{mode:0o700});
  const save=(suffix:string,v:unknown)=>{if(receipts){
    assert(path.isAbsolute(receipts));assert(fs.statSync(receipts).isDirectory());
    fs.writeFileSync(path.join(receipts,`${label}-${path.basename(root)}-${suffix}.json`),JSON.stringify(v,null,2),{flag:"wx",mode:0o600});
  }};
  function command(bin:string,args:string[]){
    const at=new Date().toISOString(),r=spawnSync(bin,args,{env:{PATH:process.env.PATH,HOME:root,LANG:"C.UTF-8",TZ:"UTC"},
      encoding:"utf8",timeout:60000,maxBuffer:4e6});
    events.push({bin,args,start:at,end:new Date().toISOString(),code:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});
    assert.equal(r.status,0);
  }
  let running=false;
  const queries:Array<{sql:string;parameters:unknown[]}>=[];
  let c:Client|undefined;
  async function cleanup(){
    const cleanupStart=new Date().toISOString();
    try {
    if(c){await c.end();c=undefined;}
    verifyFixture(root);
    if(running){command("pg_ctl",["-D",root+"/data","-m","fast","-w","stop"]);running=false;}
    verifyFixture(root);fs.rmSync(root,{recursive:true});
    save("receipt",{start,end:new Date().toISOString(),cleanupStart,cleanupSuccess:true,syntheticOnly:true,unixOnly:true,events,unattendedWaitMs:0});
    } catch(error) {
      save("cleanup-failure",{start,cleanupStart,end:new Date().toISOString(),cleanupSuccess:false,stopped:true,
        name:(error as Error).name,events});
      throw error; // no further cleanup after a safety or shutdown failure
    }
  }
  try {
    command("initdb",["-D",root+"/data","-A","trust","-U","synthetic","--no-locale","--encoding=UTF8"]);
    command("pg_ctl",["-D",root+"/data","-l",root+"/postgres.log","-o",`-k ${root}/socket -c listen_addresses='' -c unix_socket_permissions=0700`,"-w","start"]);
    running=true;c=await connectFixture(root);
    // Exact accepted baseline snapshot, not db:push or modified migrations.
    const snapshot=JSON.parse(fs.readFileSync("migrations/meta/0000_snapshot.json","utf8"));
    for(const t of Object.values(snapshot.tables) as any[]){
      const cols=Object.values(t.columns).map((v:any)=>`${quote(v.name)} ${v.type}${v.notNull?" NOT NULL":""}${v.default!==undefined?" DEFAULT "+v.default:""}${v.primaryKey?" PRIMARY KEY":""}`);
      for(const v of Object.values(t.uniqueConstraints) as any[])cols.push(`CONSTRAINT ${quote(v.name)} UNIQUE (${v.columns.map(quote).join(",")})`);
      await c.query(`CREATE TABLE public.${quote(t.name)} (${cols.join(",")})`);
      for(const ix of Object.values(t.indexes) as any[])await c.query(`CREATE ${ix.isUnique?"UNIQUE ":""}INDEX ${quote(ix.name)} ON public.${quote(t.name)} (${ix.columns.map((col:any)=>`${quote(col.expression)} ${col.asc?"ASC":"DESC"} NULLS ${col.nulls.toUpperCase()}`).join(",")})`);
    }
    // The exact accepted NORMAL migration command, explicit local target only.
    verifyFixture(root);
    const migrationStart=new Date().toISOString();
    const url=`postgresql://synthetic@localhost/postgres?host=${encodeURIComponent(root+"/socket")}`;
    const result=spawnSync("npm",["run","db:migrate"],{env:{PATH:process.env.PATH,HOME:root,LANG:"C.UTF-8",TZ:"UTC",DATABASE_URL:url},
      encoding:"utf8",timeout:60000,maxBuffer:4e6});
    events.push({command:["npm","run","db:migrate"],start:migrationStart,end:new Date().toISOString(),code:result.status,signal:result.signal,
      stdoutBytes:Buffer.byteLength(result.stdout||""),stderrBytes:Buffer.byteLength(result.stderr||""),
      stdoutSha256:crypto.createHash("sha256").update(result.stdout||"").digest("hex"),stderrSha256:crypto.createHash("sha256").update(result.stderr||"").digest("hex")});
    assert.equal(result.status,0);
    const client=c;
    const db:OwnershipDatabase={transaction:async fn=>{
      verifyFixture(root);await client.query("BEGIN");
      const tx:Transaction={query:async(sql,parameters=[])=>{queries.push({sql,parameters:structuredClone(parameters)});return client.query(sql,parameters);}};
      try{const value=await fn(tx);await client.query("COMMIT");return value;}
      catch(error){await client.query("ROLLBACK");throw error;}
    }};
    return {root,client,db,queries,cleanup};
  }catch(error){
    save("failure",{at:new Date().toISOString(),name:(error as Error).name,events});
    await cleanup();throw error;
  }
}