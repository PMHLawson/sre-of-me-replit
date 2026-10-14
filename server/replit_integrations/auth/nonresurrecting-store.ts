import session, { type SessionData } from "express-session";
import connectPg from "connect-pg-simple";
import type { Pool } from "pg";

declare module "express-session" { interface SessionData { __srePersisted?: true } }
const PgStore=connectPg(session);
const safeError=()=>new Error("Session storage operation failed");
/**
 * Loaded sessions may UPDATE, never UPSERT. New IDs may INSERT once.
 * PostgreSQL serializes UPDATE against DELETE; a write queued behind deletion
 * therefore cannot recreate the row. This covers this store's writers, not
 * other code/processes running the old upsert implementation.
 */
export class NonresurrectingStore extends PgStore {
  constructor(private readonly database:Pool){
    super({pool:database,createTableIfMissing:true,tableName:"http_sessions",
      ttl:7*24*60*60*1000,errorLog:()=>console.error("Session storage maintenance failed")});
  }
  override get(sid:string,cb:(error:unknown,value?:SessionData|null)=>void){
    super.get(sid,(error,value)=>{
      if(error){cb(safeError());return;}
      if(value)value.__srePersisted=true;
      cb(null,value);
    });
  }
  override set(sid:string,value:SessionData,cb?:(error?:unknown)=>void){
    const persisted=value.__srePersisted===true;
    value.__srePersisted=true;
    const expires=value.cookie.expires ? Math.ceil(new Date(value.cookie.expires).valueOf()/1000) :
      Math.ceil(Date.now()/1000+7*24*60*60*1000);
    const sql=persisted
      ? 'UPDATE "http_sessions" SET sess=$1, expire=to_timestamp($2) WHERE sid=$3 RETURNING sid'
      : 'INSERT INTO "http_sessions" (sess,expire,sid) VALUES ($1,to_timestamp($2),$3) ON CONFLICT DO NOTHING RETURNING sid';
    this.database.query(sql,[JSON.stringify(value),expires,sid]).then(
      result=>cb?.(result.rowCount===1?undefined:safeError()),()=>cb?.(safeError()));
  }
  override destroy(sid:string,cb?:(error?:unknown)=>void){
    super.destroy(sid,error=>cb?.(error?safeError():undefined));
  }
  override touch(sid:string,value:SessionData,cb?:(error?:unknown)=>void){
    super.touch(sid,value,(error?:unknown)=>cb?.(error?safeError():undefined));
  }
}
