import { it,expect } from "vitest";
import { createServer } from "vite";
import express from "express";
import http from "node:http";
import { once } from "node:events";
import WS from "ws";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setupVite } from "./vite";
import { projectOrigins, trustedAddressGuard } from "../shared/trusted-addresses";

const host="sre-of-me-replit.pmhlabs.org";
function request(port:number,url:string,authority:string){
  return new Promise<{status:number,body:string}>((resolve,reject)=>{
    const req=http.get({host:"127.0.0.1",port,path:url,headers:{Host:authority}},res=>{
      let body="";res.on("data",d=>body+=d);res.on("end",()=>resolve({status:res.statusCode!,body}));
    });req.on("error",reject);
  });
}
for(const mode of ["standalone","shared"]){
  it(`actual ${mode} Development HTTP, file denial and HMR boundary`,async()=>{
    const sockets:WS[]=[];let vite:Awaited<ReturnType<typeof createServer>>|undefined;
    let server:http.Server|undefined;
    const secret=path.resolve(`.env.synthetic-${randomUUID()}`);
    fs.writeFileSync(secret,"synthetic-secret-marker",{flag:"wx",mode:0o600});
    try{
      if(mode==="shared"){
        const app=express();app.use(trustedAddressGuard());server=http.createServer(app);
        vite=await setupVite(server,app);server.listen(0,"127.0.0.1");await once(server,"listening");
      }else{
        vite=await createServer({configFile:path.resolve("vite.config.ts"),server:{port:0,host:"127.0.0.1"},logLevel:"silent"});
        await vite.listen();server=vite.httpServer as http.Server;
      }
      const port=(server!.address() as import("node:net").AddressInfo).port;
      await vite.environments.client.depsOptimizer?.scanProcessing;
      for(const origin of projectOrigins()){
        const page=await request(port,"/",new URL(origin).host);
        expect(page.status).toBe(200);expect(page.body).toContain("/@vite/client");
      }
      for(const denied of ["evil.invalid",host+".evil.invalid","localhost","127.0.0.1"]){
        expect([403,421]).toContain((await request(port,"/",denied)).status);
        expect([403,421]).toContain((await request(port,"/@vite/client",denied)).status);
      }
      // A synthetic secret-named path only: never reads owner secret contents.
      const deniedFile=await request(port,"/@fs"+secret,host);
      expect(deniedFile.status).toBe(403);
      expect(deniedFile.body).not.toContain("synthetic-secret-marker");
      const url=`ws://127.0.0.1:${port}/${mode==="shared"?"vite-hmr":""}`;
      for(const [authority,token] of [["evil.invalid",vite.config.webSocketToken],[host,"bad-token"]]){
        const ws=new WS(url+"?token="+token,"vite-hmr",{headers:{Host:authority},origin:"https://"+host,handshakeTimeout:3000});sockets.push(ws);
        await new Promise<void>((resolve,reject)=>{ws.once("open",()=>reject(Error("Unexpected upgrade")));ws.once("error",()=>resolve());});
      }
      const ws=new WS(url+"?token="+vite.config.webSocketToken,"vite-hmr",{headers:{Host:host},origin:"https://"+host,handshakeTimeout:3000});sockets.push(ws);
      const connected=once(ws,"message");await once(ws,"open");expect(JSON.parse(String((await connected)[0])).type).toBe("connected");
      const custom=new Promise(resolve=>vite!.ws.on("synthetic-proof",resolve));
      ws.send(JSON.stringify({type:"custom",event:"synthetic-proof",data:{ok:true}}));expect(await custom).toEqual({ok:true});
      const reload=once(ws,"message");vite.ws.send({type:"full-reload",path:"*"});expect(JSON.parse(String((await reload)[0])).type).toBe("full-reload");
    }finally{
      for(const ws of sockets){ws.on("error",()=>{});ws.terminate();}
      if(vite){await vite.environments.client.depsOptimizer?.scanProcessing;await vite.close();}
      if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));
      fs.unlinkSync(secret);
      if(process.env.OWNERSHIP_EVIDENCE_DIR){fs.mkdirSync(process.env.OWNERSHIP_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,`address-vite-${mode}-cleanup.json`),JSON.stringify({serverStopped:!server?.listening,clientsTerminated:sockets.length,viteClosed:!!vite}));}
    }
  },60000);
}
