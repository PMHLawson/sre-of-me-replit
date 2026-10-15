import {describe,it,expect,vi} from "vitest";
import {createPinnedOwnershipUnit} from "./pinned-ownership-unit";
import {READ_TIMEOUT_MS} from "./read-budget";
const request={isAuthenticated:()=>true,user:{claims:{sub:"synthetic-transport-owner"}}};
describe("pinned transport expiry",()=>{
  it("gives BEGIN a finite native query timeout and discards an uncertain connection without queuing rollback",async()=>{
    const query=vi.fn(async(config:any)=>{expect(typeof config).toBe("object");expect(config.text).toBe("BEGIN");
      expect(config.query_timeout).toBeGreaterThan(0);expect(config.query_timeout).toBeLessThanOrEqual(READ_TIMEOUT_MS);
      throw Error("Query read timeout");});
    const release=vi.fn(),unit=createPinnedOwnershipUnit({connect:async()=>({query,release})} as any);
    await expect(unit.run(request,async()=>"unreachable")).rejects.toMatchObject({status:503,code:"RESOURCE_LIMIT_EXCEEDED"});
    expect(query).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledWith(true);
  });
  it("does not return a socket with an ambiguous connection failure to the pool",async()=>{
    const query=vi.fn(async()=>{throw Object.assign(Error("private socket detail"),{code:"ECONNRESET"});});
    const release=vi.fn(),unit=createPinnedOwnershipUnit({connect:async()=>({query,release})} as any);
    await expect(unit.run(request,async()=>"unreachable")).rejects.toMatchObject({status:503,message:"Requested history is unavailable at this size. Your records have not been changed."});
    expect(release).toHaveBeenCalledWith(true);expect(query).toHaveBeenCalledTimes(1);
  });
});
