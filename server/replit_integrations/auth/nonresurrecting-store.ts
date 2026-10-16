import session, { type SessionData } from "express-session";
import connectPg from "connect-pg-simple";
import pgStorePackage from "connect-pg-simple/package.json";
import type { Pool } from "pg";

declare module "express-session" { interface SessionData { __srePersisted?: true } }
const PgStore=connectPg(session);
const safeError=()=>new Error("Session storage operation failed");
// connect-pg-simple 10.0.0's private query bridge calls _asyncQuery, which
// awaits its own lazy table-readiness promise and returns FIRST ROW, not Result.
interface ReadyQuery {
  query(sql:string,params:unknown[],callback:(error:unknown,row?:{sid?:unknown})=>void):void;
}
/**
 * Loaded sessions may UPDATE, never UPSERT. New IDs may INSERT once.
 * PostgreSQL serializes UPDATE against DELETE; a write queued behind deletion
 * therefore cannot recreate the row. This covers this store's writers, not
 * other code/processes running the old upsert implementation.
 */
export class NonresurrectingStore extends PgStore {
  constructor(database:Pool){
    if(pgStorePackage.version!=="10.0.0")throw new Error("Unsupported session store compatibility version");
    super({pool:database,createTableIfMissing:true,tableName:"http_sessions",
      ttl:7*24*60*60*1000,errorLog:()=>console.error("Session storage maintenance failed")});
    if(typeof (this as unknown as ReadyQuery).query!=="function"){
      this.close();throw new Error("Unsupported session store query contract");
    }
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
    try{
      (this as unknown as ReadyQuery).query(sql,[JSON.stringify(value),expires,sid],
        (error,row)=>cb?.(error || row?.sid!==sid ? safeError() : undefined));
    }catch{cb?.(safeError());}
  }
  override destroy(sid:string,cb?:(error?:unknown)=>void){
    super.destroy(sid,error=>cb?.(error?safeError():undefined));
  }
  override touch(sid:string,value:SessionData,cb?:(error?:unknown)=>void){
    super.touch(sid,value,(error?:unknown)=>cb?.(error?safeError():undefined));
  }
}
