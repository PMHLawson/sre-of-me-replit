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
import viteConfig from "../vite.config";

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
    const fixtureId=randomUUID();
    const marker=`SOMR476_SYNTHETIC_${fixtureId}`;
    const secret=path.resolve(`.env.synthetic-${fixtureId}`);
    const repoCanaryDir=path.resolve(".local/private-recovery",fixtureId);
    const clientCanaryDir=path.resolve("client/.local/private-recovery",fixtureId);
    const repoCanary=path.join(repoCanaryDir,"marker.txt");
    const clientCanary=path.join(clientCanaryDir,"marker.txt");
    const clientControl=path.resolve("client",`somr476-control-${fixtureId}.txt`);
    const testCacheRoot=path.resolve("somr476-test-cache",fixtureId);
    const cacheDir=path.join(testCacheRoot,"node_modules",".vite");
    const observed:{label:string;status:number;markerExposed:boolean}[]=[];
    let resolvedFsAllow:string[]|undefined;
    let resolvedFsDeny:string[]|undefined;
    let resolvedCacheDir:string|undefined;
    let resolvedCacheRealpath:string|undefined;
    const originalConfigCacheDir=viteConfig.cacheDir;
    let configCacheOverridden=false;
    const note=async(label:string,url:string,shouldExpose=false)=>{
      const result=await request((server!.address() as import("node:net").AddressInfo).port,url,host);
      observed.push({label,status:result.status,markerExposed:result.body.includes(marker)});
      expect(result.body.includes(marker),`${mode}:${label} exposed only the synthetic canary`).toBe(shouldExpose);
      if(!shouldExpose)expect(result.status).not.toBe(200);
      else expect(result.status).toBe(200);
      return result;
    };
    try{
      for(const dir of [repoCanaryDir,clientCanaryDir])fs.mkdirSync(dir,{recursive:true,mode:0o700});
      fs.mkdirSync(cacheDir,{recursive:true,mode:0o700});
      fs.writeFileSync(repoCanary,marker,{flag:"wx",mode:0o600});
      fs.writeFileSync(clientCanary,marker,{flag:"wx",mode:0o600});
      fs.writeFileSync(secret,"synthetic-secret-marker",{flag:"wx",mode:0o600});
      fs.writeFileSync(clientControl,"SOMR476_CONTROL_OK",{flag:"wx",mode:0o600});
      if(mode==="shared"){
        const app=express();app.use(trustedAddressGuard());server=http.createServer(app);
        viteConfig.cacheDir=cacheDir;configCacheOverridden=true;
        vite=await setupVite(server,app);server.listen(0,"127.0.0.1");await once(server,"listening");
      }else{
        vite=await createServer({configFile:path.resolve("vite.config.ts"),cacheDir,server:{port:0,host:"127.0.0.1"},logLevel:"silent"});
        await vite.listen();server=vite.httpServer as http.Server;
      }
      const port=(server!.address() as import("node:net").AddressInfo).port;
      resolvedFsAllow=vite.config.server.fs.allow;
      resolvedFsDeny=vite.config.server.fs.deny;
      resolvedCacheDir=vite.config.cacheDir;
      resolvedCacheRealpath=fs.realpathSync(resolvedCacheDir!);
      expect(path.resolve(resolvedCacheDir!)).toBe(cacheDir);
      expect(resolvedCacheRealpath).toBe(path.join(fs.realpathSync(testCacheRoot),"node_modules",".vite"));
      expect(resolvedFsDeny).toContain("**/.*");
      expect(resolvedFsDeny).toContain("**/.local/**");
      for(const origin of projectOrigins()){
        const page=await request(port,"/",new URL(origin).host);
        expect(page.status).toBe(200);expect(page.body).toContain("/@vite/client");
      }
      const entry=await request(port,"/src/main.tsx",host);
      expect(entry.status).toBe(200);
      await vite.environments.client.depsOptimizer?.scanProcessing;
      for(const denied of ["evil.invalid",host+".evil.invalid","localhost","127.0.0.1"]){
        expect([403,421]).toContain((await request(port,"/",denied)).status);
        expect([403,421]).toContain((await request(port,"/@vite/client",denied)).status);
      }
      // A synthetic secret-named path only: never reads owner secret contents.
      const deniedFile=await request(port,"/@fs"+secret,host);
      expect(deniedFile.status).toBe(403);
      expect(deniedFile.body).not.toContain("synthetic-secret-marker");
      // Private-recovery canaries are synthetic files in this disposable checkout.
      // Probe both direct raw files and Vite's ?import&raw transform path.
      for(const [label,file] of [["repo-private-recovery",repoCanary],["client-private-recovery",clientCanary]] as const){
        await note(`${label}-absolute-fs`,`/@fs${file}`);
        await note(`${label}-absolute-fs-import-raw`,`/@fs${file}?import&raw`);
      }
      await note("client-root-private-recovery",`/.local/private-recovery/${fixtureId}/marker.txt`);
      const control=await request(port,`/${path.basename(clientControl)}`,host);
      expect(control.status).toBe(200);
      expect(control.body).toContain("SOMR476_CONTROL_OK");
      const optimized=Object.values(vite.environments.client.depsOptimizer?.metadata.optimized??{})[0] as {file?:string}|undefined;
      expect(optimized?.file,"Vite must create a real optimized dependency in the isolated node_modules/.vite cache").toBeTruthy();
      const optimizedRelative=path.relative(process.cwd(),optimized!.file!).split(path.sep).join("/");
      expect(optimizedRelative).toMatch(/^node_modules\/\.vite\/deps\//);
      const optimizedResponse=await request(port,`/${optimizedRelative}`,host);
      expect(optimizedResponse.status).toBe(200);
      expect(optimizedResponse.body.length).toBeGreaterThan(0);
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
      const cleanupErrors:string[]=[];
      for(const ws of sockets){ws.on("error",()=>{});ws.terminate();}
      try{if(vite){await vite.environments.client.depsOptimizer?.scanProcessing;await vite.close();}}catch(e){cleanupErrors.push(`vite:${String(e)}`);}
      try{if(server?.listening)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));}catch(e){cleanupErrors.push(`server:${String(e)}`);}
      if(configCacheOverridden)viteConfig.cacheDir=originalConfigCacheDir;
      for(const file of [secret,repoCanary,clientCanary,clientControl])try{fs.rmSync(file,{force:true});}catch(e){cleanupErrors.push(`file:${String(e)}`);}
      for(const dir of [repoCanaryDir,clientCanaryDir,testCacheRoot])try{fs.rmSync(dir,{recursive:true,force:true});}catch(e){cleanupErrors.push(`directory:${String(e)}`);}
      const cleanup={mode,serverStopped:!server?.listening,viteClosed:!vite||!vite.httpServer?.listening,clientsTerminated:sockets.length,
        canaryFilesRemoved:[secret,repoCanary,clientCanary,clientControl].every(file=>!fs.existsSync(file)),
        canaryDirectoriesRemoved:[repoCanaryDir,clientCanaryDir].every(dir=>!fs.existsSync(dir)),
        cacheDir,resolvedCacheDir,resolvedCacheRealpath,cacheRemoved:!fs.existsSync(testCacheRoot),
        resolvedFsAllow,resolvedFsDeny,observed,cleanupErrors};
      if(process.env.OWNERSHIP_EVIDENCE_DIR){fs.mkdirSync(process.env.OWNERSHIP_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.OWNERSHIP_EVIDENCE_DIR,`address-vite-${mode}-cleanup.json`),JSON.stringify(cleanup));}
      expect(cleanup.serverStopped).toBe(true);
      expect(cleanup.canaryFilesRemoved).toBe(true);
      expect(cleanup.canaryDirectoriesRemoved).toBe(true);
      expect(cleanup.cacheRemoved).toBe(true);
      expect(cleanupErrors,`${mode} fixture cleanup must complete`).toEqual([]);
    }
  },60000);
}
