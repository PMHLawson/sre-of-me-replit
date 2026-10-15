import { beforeAll,afterAll,it,expect } from "vitest";
import express from "express";
import { createServer,type Server } from "node:http";
import { createActivityV2Router } from "./activity-v2";
import { createPolicyV2Router } from "./policy-v2";
import { createOnboardingRouter } from "./onboarding";
import { WriteResourceLimitError } from "../lib/write-resource-budget";

let server:Server,base:string;
const refuse=async()=>{
  const error=new WriteResourceLimitError("rate",17);
  Object.assign(error,{privateDatabase:"private-synthetic-credential",stack:"private-synthetic-internal-stack"});
  throw error;
};
beforeAll(async()=>{
  const app=express(),authenticate:any=(request:any,_response:any,next:any)=>{
    request.user={claims:{sub:"synthetic-owned-route"}};request.isAuthenticated=()=>true;next();
  };
  app.use("/activities",createActivityV2Router({authenticate,service:Object.fromEntries(
    ["create","read","submission","list","eligibility","edit","delete","restore","mutation"].map(key=>[key,refuse])) as any}));
  app.use("/domains",createPolicyV2Router({authenticate,service:{list:refuse,read:refuse,create:refuse,configure:refuse} as any}));
  app.use("/onboarding",createOnboardingRouter({authenticate,service:{status:refuse,ensure:refuse,readSettings:refuse,updateSettings:refuse} as any}));
  server=createServer(app);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("Synthetic HTTP listener unavailable");
  base="http://127.0.0.1:"+address.port;
});
afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});

it.each([["activity","/activities"],["policy","/domains"],["onboarding","/onboarding/status"]])(
  "%s router exposes the stable typed429 and Retry-After without internal fields",async(_kind,path)=>{
    const response=await fetch(base+path),body=await response.json();
    expect(response.status).toBe(429);expect(response.headers.get("retry-after")).toBe("17");
    expect(body).toEqual({message:"Your write allowance has been reached. Please retry later.",
      code:"WRITE_RATE_LIMIT_EXCEEDED",retryAfterSeconds:17});
    expect(JSON.stringify(body)).not.toContain("private-synthetic");
  });
