import type {Pool,PoolClient,QueryConfig} from "pg";
import {performance} from "node:perf_hooks";
import {createHash} from "node:crypto";
import type {Session,Deviation,UserSettings} from "../../shared/schema";
import type {SessionSummary,DeviationSummary,HistoryPage,TextChunk,TextDetail} from "../../shared/legacy-history";
import {ResourceLimitError,MAX_READ_ROWS,MAX_COLLECTION_ROWS,READ_TIMEOUT_MS} from "./read-budget";
import {planHistoryInput} from "./history-input";
import {logicalDay,withLogicalDayMemo,type PolicyEngineOptions} from "./policy-engine";

export class HistoryInputError extends Error { readonly status=400; }
export class HistoryNotFound extends Error { readonly status=404; }
export class HistoryChanged extends Error { readonly status=409; }
type Query=(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;
const iso=(value:any):string=>new Date(value).toISOString();
const nullableIso=(value:any):string|null=>value===null?null:iso(value);
const validId=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&Buffer.byteLength(value,"utf8")<=2048&&!/\u0000/.test(value);
const own=(value:unknown)=>{if(!validId(value))throw new HistoryInputError();return value;};
const checkedRows=(rows:any[],budget:number)=>{if(rows.length>budget)throw new ResourceLimitError();return rows;};
const sessionColumns=`s.id,s.user_id AS "userId",s.domain,s.duration_minutes AS "durationMinutes",s.timestamp,
  s.deleted_at AS "deletedAt",s.is_anomaly AS "isAnomaly",
  s.notes IS NOT NULL AS "hasNotes",s.anomaly_note IS NOT NULL AS "hasAnomalyNote",
  COALESCE(octet_length(s.notes),0) AS "notesBytes",COALESCE(octet_length(s.anomaly_note),0) AS "anomalyNoteBytes"`;
const deviationColumns=`d.id,d.user_id AS "userId",d.domain,d.start_at AS "startAt",d.end_at AS "endAt",
  d.ended_at AS "endedAt",d.deleted_at AS "deletedAt",d.exclude_from_composite AS "excludeFromComposite",
  d.reason IS NOT NULL AS "hasReason",COALESCE(octet_length(d.reason),0) AS "reasonBytes"`;
const sessionSummary=(r:any):SessionSummary=>({...r,timestamp:iso(r.timestamp),deletedAt:nullableIso(r.deletedAt),
  notes:null,anomalyNote:null,notesAvailability:r.hasNotes?"not_loaded":"absent",
  anomalyNoteAvailability:r.hasAnomalyNote?"not_loaded":"absent"});
const deviationSummary=(r:any):DeviationSummary=>({...r,startAt:iso(r.startAt),endAt:nullableIso(r.endAt),
  endedAt:nullableIso(r.endedAt),deletedAt:nullableIso(r.deletedAt),reason:"",reasonAvailability:r.hasReason?"not_loaded":"absent"});
const calcSession=(r:any):Session=>({id:r.id,userId:r.userId,domain:r.domain,durationMinutes:r.durationMinutes,
  timestamp:new Date(r.timestamp),deletedAt:null,notes:null,isAnomaly:r.isAnomaly??false,anomalyNote:null});
interface Cursor {v:1;scope:string;at:string;id:string}
export interface PageInput {limit:number;cursor?:string;state?:"active"|"planned"}
export function parseHistoryPage(query:Record<string,unknown>,deviation=false):PageInput {
  if(Object.keys(query).some(k=>!["limit","cursor",...(deviation?["state"]:[])].includes(k))||
    Object.values(query).some(v=>typeof v!=="string"))throw new HistoryInputError();
  const limit=query.limit===undefined?50:Number(query.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100||query.limit!==undefined&&!/^[1-9]\d{0,2}$/.test(query.limit as string)||
    query.cursor!==undefined&&(String(query.cursor).length>4096||!String(query.cursor).length)||
    query.state!==undefined&&!["active","planned"].includes(query.state as string))throw new HistoryInputError();
  return {limit,...(query.cursor!==undefined?{cursor:query.cursor as string}:{}),
    ...(query.state!==undefined?{state:query.state as "active"|"planned"}:{})};
}
function cursorScope(userId:string,kind:string,state?:string){return createHash("sha256").update(JSON.stringify([userId,kind,state??null])).digest("hex");}
function decodeCursor(value:string|undefined,scope:string):Cursor|undefined {
  if(value===undefined)return;
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length>4096)throw 0;
    const parsed=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    // PostgreSQL exact timestamp text retains microseconds; NEVER derive a cursor from pg's Date.
    if(!parsed||Object.keys(parsed).sort().join(",")!=="at,id,scope,v"||parsed.v!==1||parsed.scope!==scope||
      !validId(parsed.id)||typeof parsed.at!=="string"||parsed.at.length>64||
      !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(parsed.at))throw 0;
    return parsed;
  }catch{throw new HistoryInputError();}
}
const encodedCursor=(scope:string,at:string,id:string)=>Buffer.from(JSON.stringify({v:1,scope,at,id})).toString("base64url");
export function historyDays(query:Record<string,unknown>):number {
  if(Object.keys(query).some(k=>k!=="days")||query.days!==undefined&&
    (typeof query.days!=="string"||!/^\d{1,3}$/.test(query.days)))throw new HistoryInputError();
  const n=query.days===undefined?14:Number(query.days);if(!Number.isInteger(n)||n<1)throw new HistoryInputError();
  return Math.min(n,60);
}
/** Every read has one checked-out owner-scoped snapshot, local statement limits
 * and an overall operation deadline. No live content is copied into error text. */
export class LegacyHistoryReads {
  constructor(private readonly pool:Pick<Pool,"connect">,private readonly clock:()=>Date=()=>new Date()){}
  private async snapshot<T>(user:string,operation:(query:Query,now:Date)=>Promise<T>):Promise<T>{
    own(user);let client:PoolClient|undefined;let begun=false,destroy=false;
    const deadline=performance.now()+15000;let statements=0;
    const control=async(sql:string,args:unknown[]=[])=>{
      const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw new ResourceLimitError();
      const config:QueryConfig & {query_timeout:number}={text:sql,values:args,query_timeout:Math.min(READ_TIMEOUT_MS,remaining)};
      return client!.query(config);
    };
    try{
      client=await this.pool.connect();await control("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");begun=true;
      const query:Query=async(sql,args=[])=>{
        const remaining=Math.floor(deadline-performance.now());if(remaining<=0||++statements>32)throw new ResourceLimitError();
        await control("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','1000',true)",
          [String(Math.min(READ_TIMEOUT_MS,remaining))]);
        return control(sql,args);
      };
      const now=this.clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error("Invalid read clock");
      const result=await operation(query,now);if(performance.now()>deadline)throw new ResourceLimitError();
      await control("COMMIT");return result;
    }catch(error){
      const transportTimeout=(error as Error)?.message==="Query read timeout";
      if(transportTimeout)destroy=true;
      if(client&&begun&&!destroy)try{
        const rollback:QueryConfig & {query_timeout:number}={text:"ROLLBACK",query_timeout:READ_TIMEOUT_MS};
        await client.query(rollback);
      }catch{destroy=true;}
      if(transportTimeout||["57014","55P03"].includes((error as {code?:string})?.code??""))throw new ResourceLimitError();
      throw error;
    }finally{client?.release(destroy);}
  }
  page(user:string,kind:"sessions"|"deleted"|"deviations",input:PageInput):Promise<HistoryPage<SessionSummary|DeviationSummary>> {
    return this.snapshot(user,async(q,now)=>{
      const scope=cursorScope(user,kind,input.state),cursor=decodeCursor(input.cursor,scope);
      const deviation=kind==="deviations",alias=deviation?"d":"s",column=deviation?"start_at":kind==="deleted"?"deleted_at":"timestamp";
      const deleted=kind==="deleted"?"IS NOT NULL":"IS NULL";
      const filter=deviation&&input.state==="active"?" AND d.ended_at IS NULL AND d.start_at<=$5 AND (d.end_at IS NULL OR d.end_at>=$5)":
        deviation&&input.state==="planned"?" AND d.ended_at IS NULL AND d.start_at>$5":"";
      const rows=(await q(`SELECT ${deviation?deviationColumns:sessionColumns},${alias}.${column}::text AS "__cursorAt"
        FROM public.${deviation?"deviations":"sessions"} ${alias}
        WHERE ${alias}.user_id=$1 AND ${alias}.deleted_at ${deleted}
        AND ($2::timestamptz IS NULL OR (${alias}.${column},${alias}.id)<($2::timestamptz,$3::varchar))${filter}
        ORDER BY ${alias}.${column} DESC,${alias}.id DESC LIMIT $4`,
        [user,cursor?.at??null,cursor?.id??null,input.limit+1,...(filter?[now]:[])])).rows;
      const selected=rows.slice(0,input.limit),last=selected.at(-1),nextCursor=rows.length>input.limit&&last?
        encodedCursor(scope,last.__cursorAt,last.id):null;
      const items=selected.map(row=>{const {__cursorAt,...clean}=row;return deviation?deviationSummary(clean):sessionSummary(clean);});
      return {items,nextCursor,complete:nextCursor===null};
    });
  }
  current(user:string,days:number){
    return this.snapshot(user,async(q,now)=>{
      const settingRows=(await q(`SELECT user_id AS "userId",day_start_hour AS "dayStartHour",timezone,window_days AS "windowDays",
        notifications_enabled AS "notificationsEnabled",notification_tier AS "notificationTier",updated_at AS "updatedAt"
        FROM public.user_settings WHERE user_id=$1`,[user])).rows;
      if(settingRows.length!==1)throw new Error("Missing settings");
      const settings=settingRows[0] as UserSettings;
      const users=(await q('SELECT created_at AS "createdAt" FROM public.users WHERE id=$1',[user])).rows;
      const opts=withLogicalDayMemo({now,dayStartHour:settings.dayStartHour,timezone:settings.timezone,windowDays:settings.windowDays,
        userCreatedAt:users[0]?.createdAt??undefined});
      const plan=planHistoryInput(opts,days);
      const contextFrom=new Date(now.getTime()-93*86400000);
      // Future legacy records remain visible in complete context and raw history;
      // neither are silently discarded to meet a resource budget.
      const contextRows=checkedRows((await q(`SELECT ${sessionColumns} FROM public.sessions s
        WHERE s.user_id=$1 AND s.deleted_at IS NULL AND s.timestamp>=$2 ORDER BY s.timestamp DESC,s.id DESC LIMIT $3`,
        [user,contextFrom,MAX_READ_ROWS+1])).rows,MAX_READ_ROWS);
      const scoreRows=checkedRows((await q(`SELECT s.id,s.user_id AS "userId",s.domain,s.duration_minutes AS "durationMinutes",s.timestamp,s.is_anomaly AS "isAnomaly"
        FROM public.sessions s WHERE s.user_id=$1 AND s.deleted_at IS NULL AND s.timestamp>=$2 AND s.timestamp<$3
        ORDER BY s.timestamp DESC,s.id DESC LIMIT $4`,[user,plan.fromInclusive,plan.untilExclusive,MAX_READ_ROWS+1])).rows,MAX_READ_ROWS);
      const deviationRows=checkedRows((await q(`SELECT ${deviationColumns} FROM public.deviations d
        WHERE d.user_id=$1 AND d.deleted_at IS NULL AND COALESCE(d.ended_at,d.end_at,'infinity'::timestamptz)>=$2
        ORDER BY d.start_at DESC,d.id DESC LIMIT $3`,[user,contextFrom,MAX_COLLECTION_ROWS+1])).rows,MAX_COLLECTION_ROWS);
      const active=deviationRows.filter(d=>d.endedAt===null&&new Date(d.startAt)<=now&&(d.endAt===null||new Date(d.endAt)>=now));
      const deviations=active.map(d=>({...d,startAt:new Date(d.startAt),endAt:d.endAt===null?null:new Date(d.endAt),
        endedAt:null,deletedAt:null,reason:""})) as Deviation[];
      const scoreSessions=scoreRows.map(calcSession).filter(s=>plan.logicalDays.has(logicalDay(s.timestamp,opts)));
      return {now,opts:{...opts,deviations},sessions:scoreSessions,context:contextRows.map(sessionSummary),
        contextDeviations:deviationRows.map(deviationSummary),fromInclusive:contextFrom.toISOString(),settings};
    });
  }
  baseline(user:string,now:Date,domain?:string,excludeId?:string){
    return this.snapshot(user,async q=>checkedRows((await q(`SELECT s.id,s.user_id AS "userId",s.domain,s.duration_minutes AS "durationMinutes",s.timestamp
      FROM public.sessions s WHERE s.user_id=$1 AND s.deleted_at IS NULL AND s.timestamp>=$2 AND s.timestamp<=$3
      AND ($4::text IS NULL OR s.domain=$4) AND ($5::text IS NULL OR s.id<>$5)
      ORDER BY s.timestamp DESC,s.id DESC LIMIT $6`,[user,new Date(now.getTime()-42*86400000),now,domain??null,excludeId??null,MAX_READ_ROWS+1])).rows,MAX_READ_ROWS).map(calcSession));
  }
  detail(user:string,kind:"sessions"|"deviations",id:string):Promise<TextDetail<SessionSummary|DeviationSummary>>{
    own(id);return this.snapshot(user,async q=>{
      const d=kind==="deviations",a=d?"d":"s";
      const rows=(await q(`SELECT ${d?deviationColumns:sessionColumns},
        encode(sha256(convert_to(to_jsonb(${a})::text,'UTF8')),'hex') AS "textVersion"
        FROM public.${kind} ${a} WHERE ${a}.user_id=$1 AND ${a}.id=$2 LIMIT 1`,[user,id])).rows;
      if(!rows.length)throw new HistoryNotFound();
      const {textVersion,...row}=rows[0];return {...(d?deviationSummary(row):sessionSummary(row)),textVersion};
    });
  }
  text(user:string,kind:"sessions"|"deviations",id:string,query:Record<string,unknown>):Promise<TextChunk>{
    own(id);
    if(Object.keys(query).some(k=>!["field","version","offset"].includes(k))||
      Object.values(query).some(v=>typeof v!=="string")||!(/^[a-f0-9]{64}$/).test(String(query.version))||
      !(/^(0|[1-9]\d{0,9})$/).test(String(query.offset??"0"))||Number(query.offset??0)>1000000000)throw new HistoryInputError();
    const field=kind==="deviations"&&query.field==="reason"?"reason":
      kind==="sessions"&&query.field==="notes"?"notes":kind==="sessions"&&query.field==="anomalyNote"?"anomaly_note":null;
    if(!field)throw new HistoryInputError();const offset=Number(query.offset??0);
    return this.snapshot(user,async q=>{
      const rows=(await q(`WITH owned AS (SELECT t.${field} AS value,
        encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS version
        FROM public.${kind} t WHERE t.user_id=$1 AND t.id=$2)
        SELECT version,CASE WHEN version=$3 THEN substring(value FROM $4::int+1 FOR 2048) END AS text,
        CASE WHEN version=$3 THEN char_length(value) END AS characters,
        CASE WHEN version=$3 THEN octet_length(value) END AS bytes FROM owned`,[user,id,query.version,offset])).rows;
      if(!rows.length)throw new HistoryNotFound();const row=rows[0];
      if(row.version!==query.version)throw new HistoryChanged();
      if(offset>(row.characters??0))throw new HistoryInputError();
      return {text:row.text??null,offset,nextOffset:offset+2048<(row.characters??0)?offset+2048:null,
        textVersion:row.version,bytes:row.bytes??0};
    });
  }
}
