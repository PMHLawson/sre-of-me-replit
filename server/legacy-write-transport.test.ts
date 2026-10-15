import {describe,expect,it,vi} from "vitest";
vi.mock("./db",()=>({db:{}}));
import {DatabaseStorage} from "./storage";
const payload={userId:"transport-owner",domain:"music" as const,durationMinutes:1,timestamp:"2026-01-01T00:00:00Z"};
describe("legacy write native transport failure handling",()=>{
 it.each(["BEGIN","SELECT id FROM public.users"])("bounds and destroys an uncertain %s connection",async lost=>{
  const configs:any[]=[],release=vi.fn(),client={release,query:vi.fn(async(config:any)=>{
   configs.push(config);
   if(config.text.startsWith(lost))throw Error("Query read timeout");
   return {command:config.text,rows:[]};
  })};
  const store=new DatabaseStorage({} as any,{connect:async()=>client} as any);
  await expect(store.createSession(payload)).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
  expect(configs.length).toBeGreaterThan(0);
  for(const config of configs){expect(config.query_timeout).toBeGreaterThan(0);expect(config.query_timeout).toBeLessThanOrEqual(2500);}
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(configs.some(x=>x.text==="COMMIT")).toBe(false);
  expect(configs.some(x=>x.text==="ROLLBACK")).toBe(false);
 });
 it("does not return an expired failed query handle to a healthy pool",async()=>{
  const release=vi.fn(),query=vi.fn(async(config:any)=>{
   if(config.text==="BEGIN")return {command:"BEGIN",rows:[]};
   throw Object.assign(Error("transport connection vanished"),{code:"08006"});
  });
  const store=new DatabaseStorage({} as any,{connect:async()=>({query,release})} as any);
  await expect(store.createSession(payload)).rejects.toMatchObject({status:503,message:"Service unavailable"});
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
 });
});
