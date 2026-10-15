import { performance } from "node:perf_hooks";
import type { Transaction } from "./org-context";
import { ResourceLimitError, MAX_READ_ROWS, READ_TIMEOUT_MS } from "./read-budget";

type Budget={active:boolean;deadline:number;statements:number;maximum:number;bytes:number;failed:boolean;admissionTail:Promise<void>};
export const MAX_READ_BYTES=8*1024*1024;
// Only guarded handles are registered. Raw PoolClients are never cached, so a
// reused connection or a later transaction cannot inherit an old allowance.
// This holds execution counters only, never owner rows or authorization.
const guarded=new WeakMap<Transaction,Budget>();
function refuse(budget?:Budget):never{if(budget)budget.failed=true;throw new ResourceLimitError();}

/** Reuse an inherited guard without resetting its monotonic request budget. */
export async function withTransactionReadBudget<T>(raw:Transaction,operation:(tx:Transaction)=>Promise<T>,absoluteDeadline?:number):Promise<T>{
  const inherited=guarded.get(raw);
  if(inherited){
    if(inherited.failed||!inherited.active||performance.now()>=inherited.deadline)refuse(inherited);
    let value:T;
    try{value=await operation(raw);}catch(error){if(error instanceof ResourceLimitError)inherited.failed=true;throw error;}
    await inherited.admissionTail;
    if(inherited.failed||performance.now()>=inherited.deadline)refuse(inherited);
    return value;
  }
  const budget:Budget={active:true,deadline:absoluteDeadline??performance.now()+READ_TIMEOUT_MS*6,statements:0,maximum:16384,bytes:0,failed:false,admissionTail:Promise.resolve()};
  const remaining=()=>Math.floor(budget.deadline-performance.now());
  const tx:Transaction={query:async(sql,values)=>{
    if(budget.failed||!budget.active||++budget.statements>budget.maximum||remaining()<1)refuse(budget);
    const timeout=Math.max(1,Math.min(READ_TIMEOUT_MS,remaining()));
    try{
      await raw.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [String(timeout),String(Math.min(1000,timeout))]);
      if(budget.failed||remaining()<1)refuse(budget);
      return await raw.query(sql,values);
    }catch(error){
      if(error instanceof ResourceLimitError||["57014","55P03"].includes(String((error as {code?:unknown})?.code)))refuse(budget);
      throw error;
    }
  }};
  guarded.set(tx,budget);
  try{
    const value=await operation(tx);
    await budget.admissionTail;
    if(budget.failed||remaining()<1)refuse(budget);
    return value;
  }catch(error){if(error instanceof ResourceLimitError)budget.failed=true;throw error;}finally{await budget.admissionTail;budget.active=false;}
}
/** Never substitute a truncated lineage, validation bundle or reconciliation. */
export function completeRead<T>(rows:T[],maximum=MAX_READ_ROWS):T[]{
  if(rows.length>maximum)throw new ResourceLimitError();
  return rows;
}

/** Admission and transfer are one serialized operation. A queued read cannot
 * reuse an allowance captured before another read or derived copy spent it. */
function serializedAdmission<T>(budget:Budget,operation:()=>Promise<T>):Promise<T>{
  const result=budget.admissionTail.then(async()=>{
    if(!budget.active||budget.failed||performance.now()>=budget.deadline)refuse(budget);
    try{return await operation();}catch(error){if(error instanceof ResourceLimitError)budget.failed=true;throw error;}
  });
  budget.admissionTail=result.then(()=>undefined,()=>undefined);
  return result;
}

/** Internal explicit SELECT admission; no SQL parsing or rewriting is used.
 * The original SELECT must carry its own owner filters, ordering, row lookahead
 * and locks. PostgreSQL withholds every native payload column on overflow,
 * before pg can transfer/decode it. Only fixed metadata crosses that boundary.
 */
export async function readComplete(
  tx:Transaction,sourceSql:string,values:unknown[],columns:readonly string[],maximum=MAX_READ_ROWS,
):Promise<any[]>{
  const budget=guarded.get(tx);
  if(!budget?.active||budget.failed||performance.now()>=budget.deadline)refuse(budget);
  return serializedAdmission(budget,async()=>{
  if(!/^\s*SELECT\b/i.test(sourceSql)||sourceSql.includes(";")||!Number.isInteger(maximum)||maximum<1||
    !columns.length||columns.some(c=>!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(c)))refuse(budget);
  const remaining=MAX_READ_BYTES-budget.bytes;
  if(remaining<1)refuse(budget);
  const countParameter="$"+(values.length+1),byteParameter="$"+(values.length+2);
  const admitted=`__read_count<=${countParameter}::bigint AND __read_bytes<=${byteParameter}::bigint`;
  const projection=columns.map(c=>`CASE WHEN ${admitted} THEN "${c}" END AS "${c}"`).join(",");
  const sql=`SELECT * FROM (WITH __bounded AS MATERIALIZED (${sourceSql}),
    __measured AS MATERIALIZED (
      SELECT b.*,sum(octet_length(to_jsonb(b)::text)::bigint+128) OVER() AS __read_bytes,
        count(*) OVER() AS __read_count,row_number() OVER() AS __read_order FROM __bounded b)
    SELECT __read_bytes,__read_count,${projection} FROM __measured ORDER BY __read_order) AS __admitted`;
  const rows=(await tx.query(sql,[...values,maximum,remaining])).rows;
  if(!rows.length)return [];
  const bytes=Number(rows[0].__read_bytes),count=Number(rows[0].__read_count);
  if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isSafeInteger(count)||count!==rows.length||
    count>maximum||bytes>remaining)refuse(budget);
  budget.bytes+=bytes;
  return rows.map(row=>Object.fromEntries(columns.map(c=>[c,row[c]])));
  });
}

export function readBytesRemaining(tx:Transaction):number{
  const budget=guarded.get(tx);
  if(!budget?.active||budget.failed||performance.now()>=budget.deadline)refuse(budget);
  return MAX_READ_BYTES-budget.bytes;
}
export function assertReadBytesAvailable(tx:Transaction,bytes:number):void{
  if(!Number.isSafeInteger(bytes)||bytes<0||bytes>readBytesRemaining(tx))refuse(guarded.get(tx));
}

/** Charge derived copies as they are built, after SQL admitted their inputs. */
export async function chargeReadBytes(tx:Transaction,bytes:number):Promise<void>{
  const budget=guarded.get(tx);if(!budget?.active||budget.failed)refuse(budget);
  return serializedAdmission(budget,async()=>{
    assertReadBytesAvailable(tx,bytes);budget.bytes+=bytes;
  });
}
