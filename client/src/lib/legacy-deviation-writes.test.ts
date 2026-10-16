import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindLegacyOwner, useAppStore } from "@/store";

const invalidate = vi.fn(async () => {});
const fetcher = vi.fn();
const saved = { id:"synthetic-deviation",userId:"deviation-owner-a",domain:"meditation",reason:"",
  startAt:"2020-01-01T00:00:00Z",endAt:null,endedAt:null,deletedAt:null,excludeFromComposite:true,
  hasReason:true,reasonBytes:27,reasonAvailability:"not_loaded" };
beforeEach(() => {
  vi.clearAllMocks(); bindLegacyOwner(null); bindLegacyOwner("deviation-owner-a");
  useAppStore.setState({invalidateAfterMutation:invalidate});
  vi.stubGlobal("fetch",fetcher);
});
afterEach(() => { bindLegacyOwner(null); vi.unstubAllGlobals(); });

it("sends the change explanation separately from the retained deviation reason",async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify(saved),{status:200,headers:{"Content-Type":"application/json"}}));
  await useAppStore.getState().updateDeviation(saved.id,{excludeFromComposite:false,changeReason:"Synthetic edit explanation"});
  const [url,init] = fetcher.mock.calls[0];
  expect(url).toBe("/api/deviations/synthetic-deviation");
  expect(JSON.parse(init.body)).toEqual({excludeFromComposite:false,changeReason:"Synthetic edit explanation"});
  expect(JSON.parse(init.body)).not.toHaveProperty("reason");
  expect(invalidate).toHaveBeenCalledExactlyOnceWith();
});
for (const action of ["end","delete"] as const) {
  it(action+" carries a deliberate explanation on the actual request",async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(saved),{status:200,headers:{"Content-Type":"application/json"}}));
    const result = action === "end" ? await useAppStore.getState().endDeviation(saved.id,"Synthetic lifecycle explanation") :
      await useAppStore.getState().deleteDeviation(saved.id,"Synthetic lifecycle explanation");
    expect(result).toBeTruthy();
    const [url,init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/deviations/synthetic-deviation"+(action==="end"?"/end":""));
    expect(init.method).toBe(action==="end"?"POST":"DELETE");
    expect(JSON.parse(init.body)).toEqual({changeReason:"Synthetic lifecycle explanation"});
    expect(invalidate).toHaveBeenCalledExactlyOnceWith();
  });
  it(action+" does not claim success or refresh saved state after rejection",async () => {
    fetcher.mockResolvedValue(new Response('{"message":"Synthetic rejected change"}',{status:400}));
    const result = action === "end" ? await useAppStore.getState().endDeviation(saved.id,"Synthetic rejected explanation") :
      await useAppStore.getState().deleteDeviation(saved.id,"Synthetic rejected explanation");
    expect(result).toBe(action==="end"?null:false); expect(invalidate).not.toHaveBeenCalled();
  });
  it(action+" cannot publish the previous account response after an account change",async () => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(done => {resolve=done;}));
    const pending = action === "end" ? useAppStore.getState().endDeviation(saved.id,"Synthetic account-bound explanation") :
      useAppStore.getState().deleteDeviation(saved.id,"Synthetic account-bound explanation");
    bindLegacyOwner("deviation-owner-b");
    resolve(new Response(JSON.stringify(saved),{status:200,headers:{"Content-Type":"application/json"}}));
    expect(await pending).toBe(action==="end"?null:false);
    expect(invalidate).not.toHaveBeenCalled();
  });
}
