import { performance } from "node:perf_hooks";
import type { Transaction } from "./org-context";
import { ResourceLimitError, MAX_READ_ROWS, READ_TIMEOUT_MS } from "./read-budget";

type Budget={active:boolean;deadline:number;statements:number;maximum:number};
// Only guarded handles are registered. Raw PoolClients are never cached, so a
// reused connection or a later transaction cannot inherit an old allowance.
// This holds execution counters only, never owner rows or authorization.
const guarded=new WeakMap<Transaction,Budget>();

/** Reuse an inherited guard without resetting its monotonic request budget. */
export async function withTransactionReadBudget<T>(raw:Transaction,operation:(tx:Transaction)=>Promise<T>):Promise<T>{
  const inherited=guarded.get(raw);
  if(inherited){
    if(!inherited.active||performance.now()>=inherited.deadline)throw new ResourceLimitError();
    const value=await operation(raw);
    if(performance.now()>=inherited.deadline)throw new ResourceLimitError();
    return value;
  }
  const budget:Budget={active:true,deadline:performance.now()+READ_TIMEOUT_MS*6,statements:0,maximum:16384};
  const remaining=()=>Math.floor(budget.deadline-performance.now());
  const tx:Transaction={query:async(sql,values)=>{
    if(!budget.active||++budget.statements>budget.maximum||remaining()<1)throw new ResourceLimitError();
    const timeout=Math.max(1,Math.min(READ_TIMEOUT_MS,remaining()));
    try{
      await raw.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [String(timeout),String(Math.min(1000,timeout))]);
      if(remaining()<1)throw new ResourceLimitError();
      return await raw.query(sql,values);
    }catch(error){
      if(["57014","55P03"].includes(String((error as {code?:unknown})?.code)))throw new ResourceLimitError();
      throw error;
    }
  }};
  guarded.set(tx,budget);
  try{
    const value=await operation(tx);
    if(remaining()<1)throw new ResourceLimitError();
    return value;
  }finally{budget.active=false;}
}
/** Never substitute a truncated lineage, validation bundle or reconciliation. */
export function completeRead<T>(rows:T[],maximum=MAX_READ_ROWS):T[]{
  if(rows.length>maximum)throw new ResourceLimitError();
  return rows;
}
