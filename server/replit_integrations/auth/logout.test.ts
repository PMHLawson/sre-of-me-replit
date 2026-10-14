import { beforeAll,afterAll,it,expect,vi } from "vitest";
import express from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { Passport } from "passport";
import { Pool } from "pg";
import http from "node:http";
import {once}from"node:events";
import {startFixture}from"../../lib/ownership-fixture";
import {NonresurrectingStore}from"./nonresurrecting-store";
import {deliberateLogout,registerLogout}from"./deliberate-logout";
import {trustedAddressGuard}from"../../../shared/trusted-addresses";
import fs from"node:fs";
import path from"node:path";
import pgStorePackage from"connect-pg-simple/package.json";
import {createRequire}from"node:module";
const signature=createRequire(import.meta.url)("cookie-signature") as {sign(value:string,secret:string):string};
const origin="https://sre-of-me-replit.pmhlabs.org";
let fixture:Awaited<ReturnType<typeof startFixture>>,pool:Pool,store:NonresurrectingStore,server:http.Server,port:number;
let providerFails=false,gate:Promise<void>|undefined;
let syntheticIdentity=0;
let delayedEntered:(()=>void)|undefined;
const saves:session.SessionData[]=[];
function request(route:string,method="GET",cookie?:string,headers:Record<string,string|string[]>={}){
 return new Promise<{status:number,body:string,cookie:string|undefined,setCookies:string[]}>((resolve,reject)=>{
  const req=http.request({host:"127.0.0.1",port,path:route,method,headers:{Host:new URL(origin).host,"X-Forwarded-Proto":"https",...(cookie?{Cookie:cookie}:{}),...headers}},res=>{
   let body="";res.on("data",d=>body+=d);res.on("end",()=>resolve({status:res.statusCode!,body,cookie:res.headers["set-cookie"]?.[0]?.split(";")[0],setCookies:res.headers["set-cookie"]??[]}));
  });req.on("error",reject);req.end();
 });
}
const deliberate={Origin:origin,"X-SRE-Logout":"1"};
async function login(){const r=await request("/synthetic-login","POST");expect(r.status).toBe(200);expect(r.cookie).toBeTruthy();return r.cookie!;}
beforeAll(async()=>{
 fixture=await startFixture("logout");
 pool=new Pool({host:fixture.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false});
 store=new NonresurrectingStore(pool);
 const app=express(),passport=new Passport();
 app.set("trust proxy",1);app.use(trustedAddressGuard());app.all("/api/logout",deliberateLogout);
 app.use(session({secret:"synthetic-fixture-only-secret",store,resave:false,saveUninitialized:false,cookie:{secure:true,httpOnly:true,sameSite:"lax",maxAge:604800000}}));
 passport.serializeUser((user,cb)=>cb(null,user));passport.deserializeUser((user:Express.User,cb)=>cb(null,user));
 app.use(passport.initialize());app.use(passport.session());
 app.post("/synthetic-login",(req,res,next)=>req.login({id:`synthetic-${++syntheticIdentity}`},e=>e?next(e):res.json({ok:true})));
 app.get("/private",(req,res)=>res.status(req.isAuthenticated()?200:401).end());
 app.get("/capture",(req,res)=>{saves.push(req.session);res.end();});
 app.post("/synthetic-refresh",(req,res)=>{
  const state=req.session as unknown as session.SessionData & {passport:{user:{refreshEvidence?:string}}};
  state.passport.user.refreshEvidence="synthetic-refreshed";
  saves.push(req.session);
  req.session.save(error=>res.status(error?503:200).end());
 });
 app.get("/delayed",async(req,res)=>{
  const old=req.session;delayedEntered?.();await gate;
  old.save(error=>res.status(error?503:200).end(error?"Sanitized failure":"saved"));
 });
 registerLogout(app,address=>{if(providerFails)throw Error("credential=SECRET");return "https://provider.synthetic.invalid/end?return="+encodeURIComponent(address);});
 app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(503).end("Sanitized failure"));
 server=http.createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");port=(server.address() as import("node:net").AddressInfo).port;
},30000);
it("direct first save bootstraps absent table with the installed readiness contract",async()=>{
 const schema="fresh_session_bootstrap";
 await fixture.client.query(`CREATE SCHEMA ${schema}`);
 const freshPool=new Pool({host:fixture.root+"/socket",port:5432,user:"synthetic",database:"postgres",password:"",ssl:false,options:`-c search_path=${schema}`});
 const freshStore=new NonresurrectingStore(freshPool);
 try{
  expect((await freshPool.query("SELECT to_regclass('http_sessions') AS name")).rows[0].name).toBeNull();
  const data={cookie:{expires:new Date(Date.now()+60000)}} as session.SessionData;
  // No preceding store read/destroy/touch/login/timer: set is its first operation.
  await new Promise<void>((resolve,reject)=>freshStore.set("first-save",data,e=>e?reject(e):resolve()));
  expect((await freshPool.query("SELECT sid FROM http_sessions")).rows).toEqual([{sid:"first-save"}]);
  await new Promise<void>((resolve,reject)=>freshStore.set("first-save",data,e=>e?reject(e):resolve()));
 }finally{freshStore.close();await freshPool.end();await fixture.client.query(`DROP SCHEMA ${schema} CASCADE`);}
});
it("legacy unmarked session loads through middleware, refreshes, then cannot resurrect",async()=>{
 const sid="unmarked-legacy-middleware";
 const data={cookie:{expires:new Date(Date.now()+60000),originalMaxAge:60000,httpOnly:true,secure:true,sameSite:"lax",path:"/"},passport:{user:{id:"synthetic-unmarked"}}};
 await pool.query("INSERT INTO http_sessions (sid,sess,expire) VALUES ($1,$2,now()+interval '1 minute')",[sid,JSON.stringify(data)]);
 const cookie="connect.sid="+encodeURIComponent("s:"+signature.sign(sid,"synthetic-fixture-only-secret"));
 expect((await request("/private","GET",cookie)).status).toBe(200);
 expect((await request("/synthetic-refresh","POST",cookie)).status).toBe(200);
 const row=(await pool.query("SELECT sess FROM http_sessions WHERE sid=$1",[sid])).rows[0].sess;
 expect(row.__srePersisted).toBe(true);expect(row.passport.user.refreshEvidence).toBe("synthetic-refreshed");
 const stale=saves.at(-1)!;
 await new Promise<void>((resolve,reject)=>store.destroy(sid,e=>e?reject(e):resolve()));
 await expect(new Promise<void>((resolve,reject)=>store.set(sid,stale,e=>e?reject(e):resolve()))).rejects.toThrow("Session storage operation failed");
 expect((await pool.query("SELECT sid FROM http_sessions WHERE sid=$1",[sid])).rowCount).toBe(0);
 expect((await request("/private","GET",cookie)).status).toBe(401);
});
it("fails closed on an unsupported private-bridge library version",()=>{
 const original=pgStorePackage.version;
 try{pgStorePackage.version="unsupported";expect(()=>new NonresurrectingStore(pool)).toThrow("compatibility version");}
 finally{pgStorePackage.version=original;}
});
it("demonstrates the installed legacy upsert resurrection before the repair",async()=>{
 const Legacy=connectPg(session),legacy=new Legacy({pool,tableName:"http_sessions",pruneSessionInterval:false});
 const data={cookie:{expires:new Date(Date.now()+60000)},passport:{user:{id:"synthetic-legacy"}}} as unknown as session.SessionData;
 try{
  await new Promise<void>((resolve,reject)=>legacy.set("synthetic-legacy-race",data,e=>e?reject(e):resolve()));
  await new Promise<void>((resolve,reject)=>legacy.destroy("synthetic-legacy-race",e=>e?reject(e):resolve()));
  await new Promise<void>((resolve,reject)=>legacy.set("synthetic-legacy-race",data,e=>e?reject(e):resolve()));
  expect((await pool.query("SELECT count(*)::int AS n FROM http_sessions WHERE sid='synthetic-legacy-race'")).rows[0].n).toBe(1);
 }finally{await new Promise<void>(resolve=>legacy.destroy("synthetic-legacy-race",()=>resolve()));legacy.close();}
});
it("rejects duplicate Origin fields",async()=>{
 const cookie=await login();expect((await request("/api/logout","POST",cookie,{...deliberate,Origin:[origin,origin]})).status).toBe(403);
 expect((await request("/private","GET",cookie)).status).toBe(200);
});
afterAll(async()=>{
 store?.close();if(server)await new Promise<void>(r=>server.close(()=>r()));
 if(pool)await pool.end();if(fixture)await fixture.cleanup();
 if(process.env.OWNERSHIP_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,"logout-server-cleanup.json"),JSON.stringify({serverStopped:!server?.listening,storeClosed:true,poolClosed:true}));
},30000);
for(const method of ["GET","HEAD"])it("rejects "+method+" without signing out",async()=>{
 const cookie=await login();expect((await request("/api/logout",method,cookie)).status).toBe(405);expect((await request("/private","GET",cookie)).status).toBe(200);
});
for(const value of [undefined,"null","https://foreign.invalid","http://sre-of-me-replit.pmhlabs.org",origin+"/",origin+", "+origin]){
 it("rejects untrusted/missing origin "+value,async()=>{const cookie=await login();expect((await request("/api/logout","POST",cookie,{"X-SRE-Logout":"1",...(value?{Origin:value}:{})})).status).toBe(403);expect((await request("/private","GET",cookie)).status).toBe(200);});
}
it("rejects absent intent and foreign fetch metadata",async()=>{
 const cookie=await login();
 for(const headers of [{Origin:origin},{...deliberate,"Sec-Fetch-Site":"cross-site"}])expect((await request("/api/logout","POST",cookie,headers)).status).toBe(403);
});
it("durably destroys old cookie, clears flags and leaves another session valid",async()=>{
 const first=await login(),other=await login();
 const result=await request("/api/logout?next=https://foreign.invalid","POST",first,deliberate);
 expect(result.status).toBe(200);const body=JSON.parse(result.body);expect(body.localSignedOut).toBe(true);
 expect(new URL(body.providerLogoutUrl).searchParams.get("return")).toBe(origin);
 expect(result.setCookies.join()).toMatch(/connect.sid=;/);expect(result.setCookies.join()).toMatch(/HttpOnly/);expect(result.setCookies.join()).toMatch(/Secure/);expect(result.setCookies.join()).toMatch(/SameSite=Lax/);
 expect((await request("/private","GET",first)).status).toBe(401);
 expect((await request("/private","GET",other)).status).toBe(200);
 expect((await request("/api/logout","POST",first,deliberate)).status).toBe(200);
 expect((await request("/private","GET",first)).status).toBe(401);
});
it("reports provider failure only after local success",async()=>{
 const cookie=await login();providerFails=true;
 try{const r=await request("/api/logout","POST",cookie,deliberate);expect(JSON.parse(r.body)).toEqual({localSignedOut:true,providerLogoutUrl:null,providerHandoffUnavailable:true});expect(r.body).not.toContain("SECRET");expect((await request("/private","GET",cookie)).status).toBe(401);}finally{providerFails=false;}
});
for(const phase of ["save","regenerate","final-destroy"]){
 it("installed Passport/session "+phase+" failure is sanitized and not claimed successful",async()=>{
  const cookie=await login();let destroys=0;
  const original=pool.query.bind(pool);
  const spy=vi.spyOn(pool,"query").mockImplementation(((...args:unknown[])=>{
   const sql=String(args[0]);
   const fail=phase==="save"?sql.startsWith("UPDATE")&&sql.includes("SET sess"):
    sql.startsWith("DELETE")&&++destroys===(phase==="regenerate"?1:2);
   if(fail)return Promise.reject(new Error("postgres://credential:SECRET@private/connection"));
   return Reflect.apply(original,pool,args);
  }) as typeof pool.query);
  const logs=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{const r=await request("/api/logout","POST",cookie,deliberate);expect(r.status).toBe(503);expect(r.body).not.toContain("SECRET");expect(r.body).not.toContain("localSignedOut");expect(JSON.stringify(logs.mock.calls)).not.toContain("SECRET");}finally{spy.mockRestore();logs.mockRestore();}
 });
}
it("waits for delayed durable writes before confirming",async()=>{
 const cookie=await login(),original=store.set.bind(store);let release!:()=>void;
 const waited=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const spy=vi.spyOn(store,"set").mockImplementation((sid,data,cb)=>{entered();void waited.then(()=>original(sid,data,cb));});
 let complete=false;const result=request("/api/logout","POST",cookie,deliberate).then(r=>{complete=true;return r});
 await ready;expect(complete).toBe(false);release();try{expect((await result).status).toBe(200);}finally{spy.mockRestore();}
});
it("late persisted session write cannot resurrect the deleted authenticated row",async()=>{
 const cookie=await login();await request("/capture","GET",cookie);const before=saves.at(-1)!;
 let release!:()=>void;gate=new Promise<void>(r=>release=r);
 const entered=new Promise<void>(r=>delayedEntered=r);
 const delayed=request("/delayed","GET",cookie);
 // Wait for an actual store read from the delayed request, not a guessed delay.
 await entered;
 expect((await request("/api/logout","POST",cookie,deliberate)).status).toBe(200);
 release();expect((await delayed).status).toBe(503);
 expect((await request("/private","GET",cookie)).status).toBe(401);
 expect(before.__srePersisted).toBe(true);
 gate=undefined;
 delayedEntered=undefined;
});
