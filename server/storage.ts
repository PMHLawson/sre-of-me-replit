import { db } from "./db";
import { LegacyHistoryReads } from "./lib/legacy-history";
import { BoundaryError,type Transaction } from "./lib/org-context";
import { withTransactionReadBudget,readComplete } from "./lib/transaction-read-budget";
import { withOwnerWriteBudget } from "./lib/write-resource-budget";
import {
  sessions,
  sessionEdits,
  deviations,
  userSettings,
  type Session,
  type InsertSession,
  type UpdateSession,
  type Deviation,
  type InsertDeviation,
  type UpdateDeviation,
  type UserSettings,
  type InsertUserSettings,
  normalizeComplianceWindowDays,activityTextWithinLimit,insertSessionSchema,updateSessionSchema,insertDeviationSchema,updateDeviationSchema,insertUserSettingsSchema,
} from "@shared/schema";
import { sql,eq,desc,gte,and,isNull,lte,lt,or,asc,gt,isNotNull } from "drizzle-orm";

export interface IStorage {
  getSessions(userId: string): Promise<Session[]>;
  getSessionsSince(userId: string, since: Date): Promise<Session[]>;
  createSession(session: InsertSession & { userId: string }): Promise<Session>;
  updateSession(userId: string, id: string, patch: UpdateSession): Promise<Session | undefined>;
  softDeleteSession(userId: string, id: string): Promise<Session | undefined>;
  restoreSession(userId: string, id: string): Promise<Session | undefined>;
  getDeletedSessions(userId: string): Promise<Session[]>;
  /**
   * Hard-delete soft-deleted sessions strictly older than `olderThan`
   * (`deletedAt < olderThan`). Active sessions (`deletedAt IS NULL`) are
   * never matched. Idempotent — once expired rows are removed a re-run with
   * the same cutoff is a no-op. Returns the number of rows removed.
   */
  purgeExpiredDeletedSessions(olderThan: Date): Promise<number>;

  // Deviations
  createDeviation(deviation: InsertDeviation & { userId: string }): Promise<Deviation>;
  getActiveDeviations(userId: string, now?: Date): Promise<Deviation[]>;
  getPlannedDeviations(userId: string, now?: Date): Promise<Deviation[]>;
  getAllDeviations(userId: string): Promise<Deviation[]>;
  getDeviation(userId: string, id: string): Promise<Deviation | undefined>;
  updateDeviation(userId: string, id: string, patch: UpdateDeviation): Promise<Deviation | undefined>;
  endDeviation(userId: string, id: string, endedAt?: Date): Promise<Deviation | undefined>;
  softDeleteDeviation(userId: string, id: string): Promise<Deviation | undefined>;

  // User settings (C3.1)
  /** Returns the user's settings; creates a default row on first call so
   *  callers never receive null. */
  getUserSettings(userId: string): Promise<UserSettings>;
  /** Upserts the supplied subset of fields onto the user's settings row,
   *  bumps `updatedAt`, and returns the updated row. */
  upsertUserSettings(userId: string, patch: InsertUserSettings): Promise<UserSettings>;
}

type MutationScope={admitMutation:()=>Promise<void>};
const sessionMutationColumns=`s.id,s.user_id AS "userId",s.domain,s.duration_minutes AS "durationMinutes",s.timestamp,
 s.deleted_at AS "deletedAt",s.is_anomaly AS "isAnomaly",NULL::text AS notes,NULL::text AS "anomalyNote",
 s.notes IS NOT NULL AS "hasNotes",s.anomaly_note IS NOT NULL AS "hasAnomalyNote",
 COALESCE(octet_length(s.notes),0) AS "notesBytes",COALESCE(octet_length(s.anomaly_note),0) AS "anomalyNoteBytes",
 CASE WHEN s.notes IS NULL THEN 'absent' ELSE 'not_loaded' END AS "notesAvailability",
 CASE WHEN s.anomaly_note IS NULL THEN 'absent' ELSE 'not_loaded' END AS "anomalyNoteAvailability"`;
const sessionMutationFields=["id","userId","domain","durationMinutes","timestamp","deletedAt","isAnomaly","notes","anomalyNote",
 "hasNotes","hasAnomalyNote","notesBytes","anomalyNoteBytes","notesAvailability","anomalyNoteAvailability"];
const deviationMutationColumns=`d.id,d.user_id AS "userId",d.domain,d.start_at AS "startAt",d.end_at AS "endAt",
 d.ended_at AS "endedAt",d.deleted_at AS "deletedAt",d.exclude_from_composite AS "excludeFromComposite",
 ''::text AS reason,d.reason IS NOT NULL AS "hasReason",COALESCE(octet_length(d.reason),0) AS "reasonBytes",
 CASE WHEN d.reason IS NULL THEN 'absent' ELSE 'not_loaded' END AS "reasonAvailability"`;
const deviationMutationFields=["id","userId","domain","startAt","endAt","endedAt","deletedAt","excludeFromComposite","reason",
 "hasReason","reasonBytes","reasonAvailability"];
const settingsMutationColumns=`user_id AS "userId",day_start_hour AS "dayStartHour",timezone,window_days AS "windowDays",
 notifications_enabled AS "notificationsEnabled",notification_tier AS "notificationTier",updated_at AS "updatedAt"`;
const settingsMutationFields=["userId","dayStartHour","timezone","windowDays","notificationsEnabled","notificationTier","updatedAt"];
// The helper supplies only static SQL fragments and positional parameters. All
// values become Drizzle parameters on this SAME transaction, never interpolated.
function transactionSql(text:string,values:unknown[]){
 const pieces=text.split(/\$(\d+)/g);
 return sql.join(pieces.map((piece,index)=>{
  if(index%2===0)return sql.raw(piece);
  const offset=Number(piece)-1;if(offset<0||offset>=values.length)throw new BoundaryError(503);
  return sql`${values[offset]}`;
 }),sql.raw(""));
}
function requireActivityText(value:string|null|undefined){
 if(typeof value==="string"&&!activityTextWithinLimit(value))throw new BoundaryError(400);
}
async function sessionMutation(tx:Transaction,userId:string,id:string,condition="TRUE",extra="",values:unknown[]=[]){
 const rows=await readComplete(tx,`SELECT ${sessionMutationColumns}${extra} FROM public.sessions s
  WHERE s.user_id=$1 AND s.id=$2 AND ${condition} LIMIT 2 FOR UPDATE`,
  [userId,id,...values],[...sessionMutationFields,...(extra?["notesSame","anomalyNoteSame","anomalyNoteNonBlank","timestampSame"]:[])],1);
 return rows[0] as Session & Record<string,any>|undefined;
}
async function deviationMutation(tx:Transaction,userId:string,id:string,condition="d.deleted_at IS NULL",reason?:string){
 const hasReason=reason!==undefined;
 const rows=await readComplete(tx,`SELECT ${deviationMutationColumns}${hasReason?',d.reason IS NOT DISTINCT FROM $3::text AS "reasonSame"':""}
  FROM public.deviations d WHERE d.user_id=$1 AND d.id=$2 AND ${condition} LIMIT 2 FOR UPDATE`,
  [userId,id,...(hasReason?[reason]:[])],[...deviationMutationFields,...(hasReason?["reasonSame"]:[])],1);
 return rows[0] as Deviation & Record<string,any>|undefined;
}
async function settingsMutation(tx:Transaction,userId:string){
 return (await readComplete(tx,`SELECT ${settingsMutationColumns} FROM public.user_settings WHERE user_id=$1 FOR UPDATE`,
  [userId],settingsMutationFields,1))[0] as UserSettings|undefined;
}

export class DatabaseStorage implements IStorage {
  constructor(private readonly database:Pick<typeof db,"transaction"|"select"|"insert"|"update"|"delete">=db){}
  private write<T>(userId:string,operation:(tx:Transaction,budget:MutationScope)=>Promise<T>):Promise<T>{
    return this.database.transaction(async orm=>{
      const native:Transaction={query:async(text,values=[])=>orm.execute(transactionSql(text,values))};
      return withTransactionReadBudget(native,tx=>withOwnerWriteBudget(tx,userId,budget=>operation(tx,budget)));
    });
  }

  async getSessions(userId: string): Promise<Session[]> {
    return this.database
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.deletedAt)))
      .orderBy(desc(sessions.timestamp));
  }

  async getSessionsSince(userId: string, since: Date): Promise<Session[]> {
    return this.database
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.deletedAt),
          gte(sessions.timestamp, since),
        ),
      )
      .orderBy(desc(sessions.timestamp));
  }

  async createSession(input: InsertSession & {userId:string}):Promise<Session>{
    const parsed=insertSessionSchema.safeParse(input);if(!parsed.success)throw new BoundaryError(400);
    const p=parsed.data,anomaly=p.isAnomaly??false;
    if(anomaly&&!p.anomalyNote?.trim())throw new BoundaryError(400);
    return this.write(input.userId,async(tx,{admitMutation})=>{
      await admitMutation();
      const created=await tx.query(`INSERT INTO public.sessions(user_id,domain,duration_minutes,timestamp,notes,is_anomaly,anomaly_note)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [input.userId,p.domain,p.durationMinutes,p.timestamp,p.notes??null,anomaly,anomaly?p.anomalyNote??null:null]);
      return (await sessionMutation(tx,input.userId,created.rows[0].id))!;
    });
  }

  async updateSession(userId:string,id:string,patch:UpdateSession):Promise<Session|undefined>{
    const parsed=updateSessionSchema.safeParse(patch);if(!parsed.success)throw new BoundaryError(400);const p=parsed.data;
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await sessionMutation(tx,userId,id,"s.deleted_at IS NULL",
        `,s.notes IS NOT DISTINCT FROM $3::text AS "notesSame",
        s.anomaly_note IS NOT DISTINCT FROM $4::text AS "anomalyNoteSame",
        COALESCE(s.anomaly_note ~ '[^[:space:]]',false) AS "anomalyNoteNonBlank",
        ($5::timestamptz IS NULL OR s.timestamp=$5::timestamptz) AS "timestampSame"`,
        [p.notes??null,p.anomalyNote??null,p.timestamp??null]);
      if(!current)return undefined;
      if(p.notes!==undefined&&!current.notesSame)requireActivityText(p.notes);
      if(typeof p.anomalyNote==="string"&&!current.anomalyNoteSame)requireActivityText(p.anomalyNote);
      const changes:Record<string,unknown>={},priorColumns:Record<string,string>={};
      const change=(column:string,value:unknown,field:string)=>{changes[column]=value;priorColumns[field]=column;};
      if(p.domain!==undefined&&p.domain!==current.domain)change("domain",p.domain,"domain");
      if(p.durationMinutes!==undefined&&p.durationMinutes!==current.durationMinutes)change("duration_minutes",p.durationMinutes,"durationMinutes");
      if(p.timestamp!==undefined&&!current.timestampSame)change("timestamp",p.timestamp,"timestamp");
      if(p.notes!==undefined&&!current.notesSame)change("notes",p.notes,"notes");
      if(p.isAnomaly!==undefined&&p.isAnomaly!==current.isAnomaly)change("is_anomaly",p.isAnomaly,"isAnomaly");
      const anomaly=p.isAnomaly??current.isAnomaly;
      if(p.isAnomaly===true&&!(typeof p.anomalyNote==="string"?p.anomalyNote.trim():current.anomalyNoteNonBlank))throw new BoundaryError(400);
      // Unsubmitted historical anomaly text is preserved, including old
      // contradictory metadata. Explicit false still intentionally clears it.
      if(p.isAnomaly!==undefined||p.anomalyNote!==undefined){
        if(!anomaly&&current.hasAnomalyNote)change("anomaly_note",null,"anomalyNote");
        else if(anomaly&&typeof p.anomalyNote==="string"&&!current.anomalyNoteSame)change("anomaly_note",p.anomalyNote,"anomalyNote");
      }
      await admitMutation();
      const pairs=Object.entries(priorColumns).flatMap(([field,column])=>["'"+field+"'","s."+column]);
      const prior=pairs.length?"jsonb_build_object("+pairs.join(",")+")::text":"'{}'::text";
      await tx.query(`INSERT INTO public.session_edits(session_id,user_id,reason,changed_fields)
        SELECT s.id,$1,$3,${prior} FROM public.sessions s WHERE s.user_id=$1 AND s.id=$2 AND s.deleted_at IS NULL`,
        [userId,id,p.reason]);
      const names=Object.keys(changes);
      if(names.length)await tx.query(`UPDATE public.sessions SET ${names.map((name,index)=>name+"=$"+(index+3)).join(",")}
        WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`,[userId,id,...Object.values(changes)]);
      return sessionMutation(tx,userId,id);
    });
  }

  async softDeleteSession(userId:string,id:string):Promise<Session|undefined>{
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await sessionMutation(tx,userId,id,"s.deleted_at IS NULL");if(!current)return undefined;
      await admitMutation();await tx.query("UPDATE public.sessions SET deleted_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL",[userId,id]);
      return sessionMutation(tx,userId,id);
    });
  }

  async restoreSession(userId:string,id:string):Promise<Session|undefined>{
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await sessionMutation(tx,userId,id,"s.deleted_at IS NOT NULL");if(!current)return undefined;
      await admitMutation();await tx.query("UPDATE public.sessions SET deleted_at=NULL WHERE user_id=$1 AND id=$2 AND deleted_at IS NOT NULL",[userId,id]);
      return sessionMutation(tx,userId,id);
    });
  }

  async getDeletedSessions(userId: string): Promise<Session[]> {
    return this.database
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNotNull(sessions.deletedAt)))
      .orderBy(desc(sessions.deletedAt));
  }

  async purgeExpiredDeletedSessions(olderThan: Date): Promise<number> {
    // Strict comparator (deletedAt < olderThan) — matches the "older than"
    // semantics of the IStorage contract. Predicate is gated to soft-deleted
    // rows only, so active sessions (deletedAt IS NULL) are never matched
    // and a re-run with the same cutoff is a no-op (idempotent).
    const removed = await this.database
      .delete(sessions)
      .where(and(isNotNull(sessions.deletedAt), lt(sessions.deletedAt, olderThan)))
      .returning({ id: sessions.id });
    return removed.length;
  }

  // ----- Deviations -----

  async createDeviation(input:InsertDeviation&{userId:string}):Promise<Deviation>{
    const parsed=insertDeviationSchema.safeParse(input);if(!parsed.success)throw new BoundaryError(400);const p=parsed.data;
    return this.write(input.userId,async(tx,{admitMutation})=>{
      await admitMutation();
      const created=await tx.query(`INSERT INTO public.deviations(user_id,domain,reason,start_at,end_at,exclude_from_composite)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[input.userId,p.domain,p.reason,p.startAt,p.endAt??null,p.excludeFromComposite??true]);
      return (await deviationMutation(tx,input.userId,created.rows[0].id))!;
    });
  }

  async getActiveDeviations(userId: string, now: Date = new Date()): Promise<Deviation[]> {
    return this.database
      .select()
      .from(deviations)
      .where(
        and(
          eq(deviations.userId, userId),
          isNull(deviations.deletedAt),
          isNull(deviations.endedAt),
          lte(deviations.startAt, now),
          or(isNull(deviations.endAt), gte(deviations.endAt, now)),
        ),
      )
      .orderBy(asc(deviations.startAt));
  }

  async getPlannedDeviations(userId: string, now: Date = new Date()): Promise<Deviation[]> {
    return this.database
      .select()
      .from(deviations)
      .where(
        and(
          eq(deviations.userId, userId),
          isNull(deviations.deletedAt),
          isNull(deviations.endedAt),
          gt(deviations.startAt, now),
        ),
      )
      .orderBy(asc(deviations.startAt));
  }

  async getAllDeviations(userId: string): Promise<Deviation[]> {
    return this.database
      .select()
      .from(deviations)
      .where(and(eq(deviations.userId, userId), isNull(deviations.deletedAt)))
      .orderBy(desc(deviations.startAt));
  }

  async getDeviation(userId: string, id: string): Promise<Deviation | undefined> {
    const [row] = await this.database
      .select()
      .from(deviations)
      .where(
        and(
          eq(deviations.userId, userId),
          eq(deviations.id, id),
          isNull(deviations.deletedAt),
        ),
      );
    return row;
  }

  async updateDeviation(userId:string,id:string,patch:UpdateDeviation):Promise<Deviation|undefined>{
    const parsed=updateDeviationSchema.safeParse(patch);if(!parsed.success)throw new BoundaryError(400);const p=parsed.data;
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await deviationMutation(tx,userId,id,"d.deleted_at IS NULL",p.reason);if(!current)return undefined;
      const update:Record<string,unknown>={};
      if(p.reason!==undefined&&!current.reasonSame){
        if(!insertDeviationSchema.shape.reason.safeParse(p.reason).success)throw new BoundaryError(400);
        update.reason=p.reason;
      }
      if(p.startAt!==undefined&&new Date(p.startAt).getTime()!==current.startAt.getTime())update.start_at=p.startAt;
      if(p.endAt!==undefined&&(p.endAt===null?null:new Date(p.endAt).getTime())!==(current.endAt?.getTime()??null))update.end_at=p.endAt;
      if(p.excludeFromComposite!==undefined&&p.excludeFromComposite!==current.excludeFromComposite)update.exclude_from_composite=p.excludeFromComposite;
      const names=Object.keys(update);if(!names.length){const {reasonSame,...summary}=current;return summary;}
      await admitMutation();await tx.query(`UPDATE public.deviations SET ${names.map((name,index)=>name+"=$"+(index+3)).join(",")}
        WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`,[userId,id,...Object.values(update)]);
      return deviationMutation(tx,userId,id);
    });
  }

  async endDeviation(userId:string,id:string,endedAt:Date=new Date()):Promise<Deviation|undefined>{
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await deviationMutation(tx,userId,id,"d.deleted_at IS NULL AND d.ended_at IS NULL");if(!current)return undefined;
      await admitMutation();await tx.query("UPDATE public.deviations SET ended_at=$3 WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL AND ended_at IS NULL",[userId,id,endedAt]);
      return deviationMutation(tx,userId,id);
    });
  }

  async softDeleteDeviation(userId:string,id:string):Promise<Deviation|undefined>{
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await deviationMutation(tx,userId,id);if(!current)return undefined;
      await admitMutation();await tx.query("UPDATE public.deviations SET deleted_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL",[userId,id]);
      return deviationMutation(tx,userId,id,"TRUE");
    });
  }

  async getUserSettings(userId:string):Promise<UserSettings>{
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await settingsMutation(tx,userId);
      if(current){
        const normalized=normalizeComplianceWindowDays(current.windowDays);if(normalized===current.windowDays)return current;
        await admitMutation();await tx.query("UPDATE public.user_settings SET window_days=$2,updated_at=clock_timestamp() WHERE user_id=$1",[userId,normalized]);
      }else{
        await admitMutation();await tx.query("INSERT INTO public.user_settings(user_id) VALUES($1)",[userId]);
      }
      return (await settingsMutation(tx,userId))!;
    });
  }

  async upsertUserSettings(userId:string,patch:InsertUserSettings):Promise<UserSettings>{
    const parsed=insertUserSettingsSchema.safeParse(patch);if(!parsed.success)throw new BoundaryError(400);const p=parsed.data;
    return this.write(userId,async(tx,{admitMutation})=>{
      const current=await settingsMutation(tx,userId),defaults={dayStartHour:4,timezone:"America/New_York",windowDays:7,
        notificationsEnabled:false,notificationTier:"WARNING"};
      const next={...(current??defaults),...(current?{windowDays:normalizeComplianceWindowDays(current.windowDays)}:{}),...p};
      await admitMutation();await tx.query(`INSERT INTO public.user_settings(user_id,day_start_hour,timezone,window_days,notifications_enabled,notification_tier,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET
        day_start_hour=EXCLUDED.day_start_hour,timezone=EXCLUDED.timezone,window_days=EXCLUDED.window_days,
        notifications_enabled=EXCLUDED.notifications_enabled,notification_tier=EXCLUDED.notification_tier,updated_at=EXCLUDED.updated_at`,
        [userId,next.dayStartHour,next.timezone,next.windowDays,next.notificationsEnabled,next.notificationTier]);
      return (await settingsMutation(tx,userId))!;
    });
  }

}

export const storage = new DatabaseStorage();

// Resolve the existing application pool only when a bounded read is requested.
// Importing unrelated storage methods must not acquire an eager pool dependency.
export const historyReads = new LegacyHistoryReads({
  connect: async () => (await import("./db")).pool.connect(),
});
