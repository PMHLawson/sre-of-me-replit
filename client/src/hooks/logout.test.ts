import {it,expect,vi,afterEach}from"vitest";
import {QueryClient}from"@tanstack/react-query";
import {logout,finishLogout,logoutFailureNotice}from"./use-auth";
afterEach(()=>vi.unstubAllGlobals());
it("unconfirmed failure copy makes no claim about server invalidation",()=>{
 expect(logoutFailureNotice).toBe("Sign-out could not be confirmed; please retry");
 expect(logoutFailureNotice).not.toMatch(/not been cleared|still signed in/);
});
it("requires server confirmation and explicit same-origin POST intent, not a fetch redirect",async()=>{
 const fake=vi.fn(async()=>new Response(JSON.stringify({localSignedOut:true,providerLogoutUrl:"https://provider.synthetic.invalid"})));
 vi.stubGlobal("fetch",fake);expect((await logout()).localSignedOut).toBe(true);
 expect(fake.mock.calls[0]).toEqual(["/api/logout",{method:"POST",credentials:"include",redirect:"error",headers:{"X-SRE-Logout":"1"}}]);
});
it("network/storage/invalid responses cannot confirm logout",async()=>{
 for(const response of [new Response("SECRET",{status:503}),new Response("{}")]){
  vi.stubGlobal("fetch",vi.fn(async()=>response));await expect(logout()).rejects.toThrow("could not be confirmed");
 }
 vi.stubGlobal("fetch",vi.fn(async()=>{throw Error("network");}));await expect(logout()).rejects.toThrow();
});
it("cancels installed query work and clears private cache before top-level handoff",async()=>{
 const cache=new QueryClient();cache.setQueryData(["private-user"],{secret:"old-account"});
 let resolve!:(v:unknown)=>void;const pending=cache.fetchQuery({queryKey:["delayed-private"],queryFn:()=>new Promise(r=>resolve=r)}).catch(()=>{});
 const navigate=vi.fn(()=>expect(cache.getQueryCache().getAll()).toHaveLength(0));
 await finishLogout({localSignedOut:true,providerLogoutUrl:"https://provider.synthetic.invalid"},cache,navigate);
 resolve({secret:"late-old-account"});await pending;
 expect(cache.getQueryCache().getAll()).toHaveLength(0);expect(navigate).toHaveBeenCalledWith("https://provider.synthetic.invalid");cache.clear();
});
it("provider unavailability navigates locally with a distinct truthful notice",async()=>{
 const cache=new QueryClient(),navigate=vi.fn();await finishLogout({localSignedOut:true,providerLogoutUrl:null},cache,navigate);expect(navigate).toHaveBeenCalledWith("/?localSignedOut=1");
});
it("blocked provider navigation cannot be misreported as local invalidation failure",async()=>{
 const cache=new QueryClient();cache.setQueryData(["private"],"synthetic");
 const navigate=vi.fn(()=>{throw Error("Navigation blocked");});
 expect(await finishLogout({localSignedOut:true,providerLogoutUrl:"https://provider.synthetic.invalid"},cache,navigate)).toEqual({localSignedOut:true,providerHandoffFailed:true});
 expect(cache.getQueryCache().getAll()).toHaveLength(0);
 expect(navigate).toHaveBeenLastCalledWith("/?localSignedOut=1");
});
