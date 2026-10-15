import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("../lib/pinned-ownership-unit",()=>({createPinnedOwnershipUnit:()=>({})}));
vi.mock("./legacy-activity-mutations",()=>({createLegacyActivityMutations:()=>({create:mocks.create})}));
import {createLegacySessionAdapter} from "./legacy-session-adapter";
const actor="summary-owner",request={isAuthenticated:()=>true,user:{claims:{sub:actor}}};
const row={id:"summary-session",user_id:actor,domain:"music",duration_minutes:1,timestamp:"2026-01-01T00:00:00.123456Z",
 notes:null,anomaly_note:null,is_anomaly:false,deleted_at:null,hasNotes:true,hasAnomalyNote:false,
 notesBytes:0,anomalyNoteBytes:0,notesAvailability:"not_loaded",anomalyNoteAvailability:"absent",
 org_id:"PRIVATE_ORG",observation_id:"PRIVATE_OBSERVATION",audit_snapshot:"PRIVATE_AUDIT"};
function adapter(){return createLegacySessionAdapter({config:{enabled:true,owners:[actor]},getPool:async()=>({connect:vi.fn()}) as any});}
beforeEach(()=>{mocks.create.mockReset();mocks.create.mockResolvedValue({...row});});
describe("activated legacy mutation summary boundary",()=>{
 it("forwards only explicit bounded metadata and preserves empty-present versus absent text",async()=>{
  const result=await adapter().create(request,{});
  expect(result).toEqual({id:row.id,userId:actor,domain:"music",durationMinutes:1,timestamp:"2026-01-01T00:00:00.123Z",
   notes:null,anomalyNote:null,isAnomaly:false,deletedAt:null,hasNotes:true,hasAnomalyNote:false,
   notesBytes:0,anomalyNoteBytes:0,notesAvailability:"not_loaded",anomalyNoteAvailability:"absent"});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
 });
 it.each([
  {hasNotes:undefined},{hasNotes:false,notesBytes:1,notesAvailability:"absent"},
  {notesBytes:-1},{notesBytes:1.5},{notesBytes:NaN},{notesAvailability:"loaded"},
  {hasNotes:true,notesAvailability:"absent"},{hasAnomalyNote:false,anomalyNoteBytes:1},
  {anomalyNoteAvailability:"not_loaded"},{notes:"UNBOUNDED_PRIVATE_TEXT"},{anomaly_note:"UNBOUNDED_PRIVATE_TEXT"},
 ])("fails closed instead of publishing malformed or plaintext summary %#",async patch=>{
  mocks.create.mockResolvedValue({...row,...patch});
  await expect(adapter().create(request,{})).rejects.toMatchObject({status:503,message:"Service unavailable"});
 });
 it("retains the explicit disabled adapter path without requesting a pool or manufacturing summary fields",async()=>{
  const getPool=vi.fn();const disabled=createLegacySessionAdapter({config:{enabled:false,owners:[]},getPool});
  expect(await disabled.create(request,{})).toBeUndefined();expect(getPool).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
 });
});
