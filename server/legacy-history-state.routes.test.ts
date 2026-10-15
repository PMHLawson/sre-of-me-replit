import {beforeAll,beforeEach,afterAll,it,expect,vi} from "vitest";
import express from "express";
import {createServer} from "node:http";
const fake=vi.hoisted(()=>({current:vi.fn(),getUserSettings:vi.fn()}));
vi.mock("./db",()=>{throw Error("FORBIDDEN: real database import");});
vi.mock("./storage",()=>({storage:{getUserSettings:fake.getUserSettings},historyReads:{current:fake.current}}));
vi.mock("./replit_integrations/auth/storage",()=>({authStorage:{}}));
vi.mock("./replit_integrations/auth",()=>({isAuthenticated:(req:any,_res:any,next:any)=>{
 req.user={claims:{sub:"synthetic-read-owner"}};req.isAuthenticated=()=>true;next();
}}));
import {registerRoutes} from "./routes";
import {ResourceLimitError} from "./lib/read-budget";
const app=express(),server=createServer(app),now=new Date("2026-10-15T12:00:00Z");
let base:string;
const paths=["/api/session-state?days=14","/api/sessions/context","/api/policy-state","/api/escalation-state?days=14"];
beforeAll(async()=>{
 await registerRoutes(server,app);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();if(!address||typeof address==="string")throw Error("Missing owned synthetic listener");
 base="http://127.0.0.1:"+address.port;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
beforeEach(()=>{
 fake.current.mockReset();fake.getUserSettings.mockReset();
 fake.getUserSettings.mockRejectedValue(Error("READONLY ROUTES MUST NOT PERSIST SETTINGS"));
 fake.current.mockResolvedValue({ownerUserId:"synthetic-read-owner",now,
  opts:{now,dayStartHour:4,timezone:"America/New_York",windowDays:7,deviations:[]},sessions:[],context:[],contextDeviations:[],
  fromInclusive:"2026-07-14T12:00:00.000Z",
  settings:{userId:"synthetic-read-owner",dayStartHour:4,timezone:"America/New_York",windowDays:7,
   notificationsEnabled:false,notificationTier:"WARNING",updatedAt:now}});
});
it.each(paths)("derived/read context %s uses only its bounded readonly snapshot",async path=>{
 const response=await fetch(base+path);
 expect(response.status).toBe(200);
 expect(fake.current).toHaveBeenCalledExactlyOnceWith("synthetic-read-owner",14);
 expect(fake.getUserSettings).not.toHaveBeenCalled();
});
it.each(paths)("derived/read context %s returns503 without a partial or healthy result on admission failure",async path=>{
 fake.current.mockRejectedValue(new ResourceLimitError());
 const response=await fetch(base+path),body=await response.json();
 expect(response.status).toBe(503);expect(body).toEqual({
  message:"Requested history is unavailable at this size. Your records have not been changed.",code:"RESOURCE_LIMIT_EXCEEDED"});
 expect(fake.getUserSettings).not.toHaveBeenCalled();
 expect(body).not.toHaveProperty("policyState");expect(body).not.toHaveProperty("services");expect(body).not.toHaveProperty("highestTier");
});
it("normal settings access retains its original persistence service",async()=>{
 const saved={userId:"synthetic-read-owner",windowDays:7};fake.getUserSettings.mockResolvedValue(saved);
 const response=await fetch(base+"/api/settings");
 expect(response.status).toBe(200);expect(await response.json()).toEqual(saved);
 expect(fake.getUserSettings).toHaveBeenCalledExactlyOnceWith("synthetic-read-owner");
 expect(fake.current).not.toHaveBeenCalled();
});
