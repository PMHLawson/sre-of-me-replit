import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseConnection } from "./database-connection";
import { Pool } from "pg";
import session from "express-session";
import connectPg from "connect-pg-simple";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

const remote = { DATABASE_URL: "postgresql://fixture:synthetic@127.0.0.1:5432/fixture", NODE_ENV: "production" };
describe("connection policy", () => {
  it("pins verification without passing a re-parsed URL", () => {
    const config = databaseConnection(remote);
    expect(config.connectionString).toBeUndefined();
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true, minVersion: "TLSv1.2" });
    expect(config.host).toBe("127.0.0.1");
  });
  for (const mode of ["disable","prefer","allow","no-verify","verify-ca"]) {
    it(`rejects remote sslmode=${mode} from either source`, () => {
      expect(() => databaseConnection({...remote,DATABASE_URL:remote.DATABASE_URL+"?sslmode="+mode})).toThrow();
      expect(() => databaseConnection({...remote,PGSSLMODE:mode})).toThrow();
    });
  }
  for (const option of ["ssl=false","ssl=no-verify","sslrootcert=/tmp/fake","host=helium","sslmode=require&sslmode=disable","uselibpqcompat=true","options=unsafe","user=other"]) {
    it(`rejects competing URL option ${option}`, () => {
      expect(() => databaseConnection({...remote,DATABASE_URL:remote.DATABASE_URL+"?"+option})).toThrow();
    });
  }
  it("enforces verification for require and catches contradictory environment", () => {
    expect(databaseConnection({...remote,DATABASE_URL:remote.DATABASE_URL+"?sslmode=require"}).ssl).toMatchObject({rejectUnauthorized:true});
    expect(() => databaseConnection({...remote,PGSSLMODE:"disable"})).toThrow();
    expect(() => databaseConnection({...remote,NODE_TLS_REJECT_UNAUTHORIZED:"0"})).toThrow();
    expect(() => databaseConnection({...remote,PGSSLROOTCERT:"/tmp/cert"})).toThrow();
  });
  it("only recognizes explicitly local Development endpoints", () => {
    const local={DATABASE_URL:"postgres://fixture:pw@helium:5432/fixture?sslmode=disable",NODE_ENV:"development",REPL_ID:"synthetic"};
    expect(databaseConnection(local).ssl).toBe(false);
    expect(() => databaseConnection({...local,NODE_ENV:"production"})).toThrow();
    expect(() => databaseConnection({...local,REPL_ID:undefined})).toThrow();
    expect(databaseConnection({PGHOST:"/tmp/fixture",PGUSER:"fixture",PGDATABASE:"fixture",NODE_ENV:"test"}).ssl).toBe(false);
    expect(databaseConnection({...remote,NODE_ENV:"development"}).ssl).not.toBe(false);
    expect(() => databaseConnection({...local,DATABASE_CA_CERT:"not-a-certificate"})).toThrow();
  });
  it("fails without a target and never leaks malformed credentials", () => {
    expect(() => databaseConnection({})).toThrow("policy rejected");
    expect(() => databaseConnection({DATABASE_URL:"private-broken-url"})).toThrow("policy rejected");
  });
});

describe("real disposable PostgreSQL TLS: app pool and session store", () => {
  let root: string, port: number, running = false;
  const pools: Pool[] = [];
  const receipts: object[] = [];
  const env = {PATH:process.env.PATH,HOME:process.env.HOME,LANG:"C.UTF-8"};
  const run = (command: string, args: string[]) => {
    try { return execFileSync(command,args,{env,encoding:"utf8",timeout:30000,stdio:["ignore","pipe","pipe"]}); }
    catch (error) {
      if(root) fs.appendFileSync(path.join(root,"failed-command.log"),String((error as {stderr?:unknown}).stderr ?? "command failed"));
      throw error;
    }
  };
  function stop() {
    if(running){run("pg_ctl",["-D",root+"/data","-m","fast","-w","stop"]);running=false;}
  }
  function start(cert: string | false) {
    stop();
    const options=`-p ${port} -k ${root} -c listen_addresses=127.0.0.1 -c ssl=${cert?"on":"off"}`+
      (cert?` -c ssl_cert_file=${root}/${cert}.crt -c ssl_key_file=${root}/${cert}.key`:"");
    run("pg_ctl",["-D",root+"/data","-l",root+"/postgres.log","-o",options,"-w","start"]);running=true;
  }
  beforeAll(async () => {
    root=fs.mkdtempSync(path.join(os.tmpdir(),"somr466-tls-"));fs.chmodSync(root,0o700);
    try {
      const socket=net.createServer();await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));
      port=(socket.address() as net.AddressInfo).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
      run("initdb",["-D",root+"/data","-U","fixture","--auth-local=trust","--auth-host=trust"]);
      run("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",root+"/ca.key","-out",root+"/ca.crt","-days","2","-subj","/CN=Synthetic Test CA"]);
      for(const name of ["valid","wrong","expired","untrusted"]){
        run("openssl",["req","-new","-newkey","rsa:2048","-nodes","-keyout",root+`/${name}.key`,"-out",root+`/${name}.csr`,"-subj","/CN=Synthetic Server"]);
        fs.chmodSync(root+`/${name}.key`,0o600);
        fs.writeFileSync(root+`/${name}.ext`,`subjectAltName=${name==="wrong"?"DNS:wrong.invalid":"IP:127.0.0.1"}\nextendedKeyUsage=serverAuth\n`);
        const signing=name==="untrusted"?["-signkey",root+`/${name}.key`]:["-CA",root+"/ca.crt","-CAkey",root+"/ca.key","-CAcreateserial"];
        run("openssl",["x509","-req","-in",root+`/${name}.csr`,...signing,"-out",root+`/${name}.crt`,"-days",name==="expired"?"-1":"2","-extfile",root+`/${name}.ext`]);
      }
    } catch(error) {stop();throw error;}
  },30000);
  const config = (trust=true) => databaseConnection({
    ...remote,DATABASE_URL:`postgres://fixture:synthetic@127.0.0.1:${port}/postgres?sslmode=require`,
    ...(trust?{DATABASE_CA_CERT:fs.readFileSync(root+"/ca.crt","utf8")}:{})
  });
  it("trusted matching TLS works for actual app Pool and actual session store", async () => {
    start("valid");const pool=new Pool(config());pools.push(pool);
    const result=await pool.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
    expect(result.rows[0].ssl).toBe(true);
    await pool.query('CREATE TABLE http_sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp NOT NULL)');
    const Store=connectPg(session),store=new Store({pool,tableName:"http_sessions",createTableIfMissing:false,pruneSessionInterval:false});
    try {
      await new Promise<void>((resolve,reject)=>store.set("synthetic",{cookie:{maxAge:10000},fixture:true} as unknown as session.SessionData,error=>error?reject(error):resolve()));
      const value=await new Promise<session.SessionData | null | undefined>((resolve,reject)=>store.get("synthetic",(error,value)=>error?reject(error):resolve(value)));
      expect(value).toMatchObject({fixture:true});
    }finally{await store.close();await pool.end();pools.splice(pools.indexOf(pool),1);}
    receipts.push({case:"valid",app:true,session:true});
  });
  for(const name of ["wrong","expired","untrusted","plaintext","system-roots"]){
    it(`rejects ${name} for both consumers`,async()=>{
      start(name==="plaintext"?false:name==="system-roots"?"valid":name);
      const pool=new Pool(config(name!=="system-roots"));pools.push(pool);
      const Store=connectPg(session),store=new Store({pool,createTableIfMissing:false,pruneSessionInterval:false});
      const reason = name==="wrong" ? /does not match certificate/ :
        name==="expired" ? /certificate has expired/ :
        name==="plaintext" ? /does not support SSL/ : /self.signed certificate|unable to verify|unable to get local issuer/i;
      try{
        await expect(pool.query("SELECT 1")).rejects.toThrow(reason);
        await expect(new Promise((resolve,reject)=>store.get("synthetic",(error,value)=>error?reject(error):resolve(value)))).rejects.toThrow(reason);
      }finally{await store.close();await pool.end();pools.splice(pools.indexOf(pool),1);}
      receipts.push({case:name,appRejected:true,sessionRejected:true});
    });
  }
  afterAll(async()=>{
    for(const pool of pools)await pool.end();
    stop();
    const stopped=root&&!fs.existsSync(root+"/data/postmaster.pid");
    if(stopped && process.env.OWNERSHIP_EVIDENCE_DIR && fs.existsSync(root+"/failed-command.log")){
      fs.mkdirSync(process.env.OWNERSHIP_EVIDENCE_DIR,{recursive:true});
      fs.copyFileSync(root+"/failed-command.log",path.join(process.env.OWNERSHIP_EVIDENCE_DIR,`failed-${path.basename(root)}.log`));
    }
    if(stopped)fs.rmSync(root,{recursive:true,force:true});
    if(process.env.OWNERSHIP_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.OWNERSHIP_EVIDENCE_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,`tls-${path.basename(root)}.json`),
        JSON.stringify({root,receipts,serverStopped:stopped,removed:!fs.existsSync(root),poolsClosed:true}));
    }
    expect(stopped).toBe(true);
  });
});
