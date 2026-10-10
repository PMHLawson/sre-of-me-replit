import { describe,it,expect,vi } from "vitest";
import { matchTrustedOrigin,projectOrigins } from "../shared/trusted-addresses";
import express from "express";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
const proof=vi.hoisted(()=>({session:0,strategies:[] as {name:string,callbackURL:string}[],authenticated:[] as string[]}));
vi.mock("./db",()=>({pool:{}}));
vi.mock("./replit_integrations/auth/storage",()=>({authStorage:{}}));
vi.mock("openid-client",()=>({discovery:vi.fn(async()=>({}))}));
vi.mock("openid-client/passport",()=>({Strategy:class { constructor(options:{name:string,callbackURL:string}){proof.strategies.push(options);} }}));
vi.mock("passport",()=>({default:{
  use:vi.fn(),initialize:()=> (_q:unknown,_s:unknown,next:()=>void)=>next(),
  session:()=> (_q:unknown,_s:unknown,next:()=>void)=>next(),
  serializeUser:vi.fn(),deserializeUser:vi.fn(),
  authenticate:(name:string)=> (_q:unknown,s:{end:(body:string)=>void})=>{proof.authenticated.push(name);s.end("synthetic authentication");},
}}));
vi.mock("express-session",()=>({default:()=> (_q:unknown,_s:unknown,next:()=>void)=>{proof.session++;next();}}));
vi.mock("connect-pg-simple",()=>({default:()=>class {}}));
import { setupAuth } from "./replit_integrations/auth/replitAuth";
const host="sre-of-me-replit.pmhlabs.org",origins=projectOrigins({});
function request(port:number,route:string,headers:string[]){
  return new Promise<{status:number,body:string,cookie:unknown}>((resolve,reject)=>{
    const req=http.request({host:"127.0.0.1",port,path:route,headers},res=>{
      let body="";res.on("data",d=>body+=d);res.on("end",()=>resolve({status:res.statusCode!,body,cookie:res.headers["set-cookie"]}));
    });req.on("error",reject);req.end();
  });
}
describe("exact project authority",()=>{
  it("trusts only configured exact origins",()=>{
    expect(projectOrigins({REPLIT_DEV_DOMAIN:"preview.example.invalid"})).toContain("https://preview.example.invalid");
    expect(projectOrigins({NODE_ENV:"production",REPLIT_DEV_DOMAIN:"preview.example.invalid"})).not.toContain("https://preview.example.invalid");
    expect(()=>projectOrigins({REPLIT_DEV_DOMAIN:".replit.dev"})).toThrow();
  });
  for(const value of ["evil.invalid",host+".evil.invalid","evil.replit.app",host+".",host+":444",host+":0443",host+",evil.invalid","user@"+host,"https://"+host,host+"/",host+"%00"," "+host,"127.0.0.1","localhost","[::1]"]){
    it(`rejects ${value}`,()=>expect(matchTrustedOrigin({rawHeaders:["Host",value]},origins)).toBeUndefined());
  }
  it("accepts canonical case/default port and matching TLS termination headers",()=>{
    expect(matchTrustedOrigin({rawHeaders:["Host",host.toUpperCase()+":443","X-Forwarded-Host",host,"X-Forwarded-Proto","https"]},origins)).toBe("https://"+host);
  });
  for(const extra of [
    ["Host",host],["X-Forwarded-Host","evil.invalid"],["X-Forwarded-Host",host+", "+host],
    ["X-Forwarded-Host",host,"X-Forwarded-Host",host],["Forwarded","host="+host],
    ["X-Forwarded-Proto","http"],["X-Forwarded-Proto","https,http"],
    ["X-Forwarded-Proto","https","X-Forwarded-Proto","https"],
  ])it("rejects ambiguous/unapproved forwarded inputs "+extra.join(":"),()=>{
    expect(matchTrustedOrigin({rawHeaders:["Host",host,...extra]},origins)).toBeUndefined();
  });
  it("actual auth routes reject before session/auth effects and bound registrations",async()=>{
    const app=express();await setupAuth(app);const server=http.createServer(app);
    server.listen(0,"127.0.0.1");await once(server,"listening");
    const port=(server.address() as import("node:net").AddressInfo).port;
    try{
      const registered=proof.strategies.length;
      expect(registered).toBe(projectOrigins().length);
      for(let i=0;i<30;i++){
        const response=await request(port,i%2?"/api/login":"/api/callback",["Host",`attacker${i}.invalid`]);
        expect(response.status).toBe(421);expect(response.cookie).toBeUndefined();
      }
      expect(proof.session).toBe(0);expect(proof.authenticated).toHaveLength(0);
      for(const origin of projectOrigins()){
        for(const route of ["/api/login","/api/callback"]){
          expect((await request(port,route,["Host",new URL(origin).host,"X-Forwarded-Host",new URL(origin).host,"X-Forwarded-Proto","https"])).status).toBe(200);
          expect(proof.authenticated.at(-1)).toBe("replitauth:"+origin);
          expect(proof.strategies.find(s=>s.name==="replitauth:"+origin)?.callbackURL).toBe(origin+"/api/callback");
        }
      }
      expect(proof.strategies).toHaveLength(registered);
      const count=proof.session;
      for(const route of ["/api/login","/api/callback"]){
        expect((await request(port,route,["Host",host,"X-Forwarded-Host","evil.invalid"])).status).toBe(421);
        expect((await request(port,route,["Host",host,"X-Forwarded-Proto","http"])).status).toBe(421);
      }
      expect(proof.session).toBe(count);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(process.env.OWNERSHIP_EVIDENCE_DIR){fs.mkdirSync(process.env.OWNERSHIP_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,"address-auth-cleanup.json"),JSON.stringify({listening:server.listening,syntheticAuthOnly:true}));}}
  });
});
