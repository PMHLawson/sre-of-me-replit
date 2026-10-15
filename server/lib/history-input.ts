import {completedWindowDays,logicalDay,sustainedWindowAnchor,type PolicyEngineOptions} from "./policy-engine";
import {escalationHistoryAnchors} from "./escalation";
export interface HistoryInputPlan {logicalDays:ReadonlySet<string>;fromInclusive:Date;untilExclusive:Date}
/** Union actual engine windows, not max(history,window) or elapsed-day approximations. */
export function planHistoryInput(opts:PolicyEngineOptions,historyDays=14):HistoryInputPlan {
  if(!Number.isInteger(historyDays)||historyDays<1||historyDays>60)throw new Error("Invalid history length");
  const keys=new Set<string>(),add=(o:PolicyEngineOptions)=>completedWindowDays(o).forEach(k=>keys.add(k));
  add(opts);
  for(const day of completedWindowDays(opts))add({...opts,now:sustainedWindowAnchor(day)});
  for(const now of escalationHistoryAnchors(opts,historyDays))add({...opts,now});
  for(const windowDays of [7,14,28,42,90])add({...opts,windowDays});
  keys.add(logicalDay(opts.now??new Date(),opts));
  const ordered=Array.from(keys).sort();
  // A logical day may comprise parts of TWO local calendar dates. These coarse
  // UTC guards deliberately contain both across all IANA offsets/DST changes;
  // logicalDay membership is authoritative after the bounded minimal DB read.
  const first=Date.parse(ordered[0]+"T00:00:00Z"),last=Date.parse(ordered.at(-1)!+"T00:00:00Z");
  return {logicalDays:keys,fromInclusive:new Date(first-86400000),untilExclusive:new Date(last+3*86400000)};
}
