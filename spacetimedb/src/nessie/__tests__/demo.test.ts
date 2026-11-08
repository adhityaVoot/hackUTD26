import { describe, expect, it, vi } from 'vitest';
import { bankTransaction, cents } from '../mapping';
import { nessieClient } from '../client';
vi.mock('../../auth', () => ({ envValue: (tx: any, key: string) => tx.env[key], requireMember: (tx: any) => tx.me }));
vi.mock('../../recompute', () => ({ recomputeScenario: vi.fn() }));
import { registerNessie } from '../module';

function fixture() {
  const data: Record<string, any[]> = {};
  let sequence = 10n;
  const db = new Proxy({}, {get: (_, name: string) => {
    const rows = data[name] ??= [];
    return new Proxy({iter: () => rows.values(), insert: (r: any) => { const row = {...r,id:r.id===0n?++sequence:r.id};rows.push(row);return row; }}, {
      get: (obj: any, column: string) => column in obj ? obj[column] : {
        find: (value: any) => rows.find(r => r[column]===value),
        filter: (value: any) => rows.filter(r => r[column]===value),
        update: (r: any) => {const i=rows.findIndex(x=>x[column]===r[column]);rows[i]=r;return r;},
        delete: (id: any) => {const i=rows.findIndex(x=>x[column]===id);if(i>=0)rows.splice(i,1);},
      }
    });
  }});
  const tx = {db,me:{person:{id:1n,personaKey:'priya'},household:{id:2n,inviteCode:'PATELS',simDay:0,baselineScenarioId:0n}},
    timestamp: {},env:{NESSIE_API_KEY:'secret-test',NESSIE_DEMO_CUSTOMERS:'{"PATELS:priya":"customer1"}'}};
  const calls: string[] = [];
  const ctx = {withTx:(fn:any)=>fn(tx),http:{fetch:(url:string)=>{
    calls.push(url);
    const body = url.includes('/customers/') ? [{_id:'bank1',customer_id:'customer1',type:'Checking',nickname:'Demo Checking',balance:4200}] :
      url.includes('/withdrawals?') ? [{_id:'txn1',status:'completed',transaction_date:'2026-10-20',amount:125}] : [];
    return {status:200,text:()=>JSON.stringify(body)};
  }}};
  const run = registerNessie({procedure: (_args:any,_ret:any,fn:any)=>fn} as any) as any;
  return {data,tx,ctx,calls,run};
}
describe('Nessie demo import',()=>{
  it('uses cents and signed transaction amounts',()=>{
    expect(cents(12.34)).toBe(1234n);
    expect(bankTransaction({_id:'x',status:'completed',transaction_date:'2026-10-20',amount:12.34},'withdrawal','a')?.amountCents).toBe(-1234n);
    expect(bankTransaction({_id:'x',status:'pending'},'deposit','a')).toBeNull();
  });
  it('records each side of a transfer without changing household net cash',()=>{
    const row={_id:'t',status:'completed',transaction_date:'2026-10-20',amount:50,payer_id:'a',payee_id:'b'};
    const out=bankTransaction(row,'transfer','a')!, incoming=bankTransaction(row,'transfer','b')!;
    expect(out.amountCents+incoming.amountCents).toBe(0n);expect(out.nessieId).not.toBe(incoming.nessieId);
    expect(()=>bankTransaction(row,'transfer','c')).toThrow('mismatch');
  });
  it('rejects invalid dates and negative provider amounts',()=>{
    const row={_id:'t',status:'completed',transaction_date:'2026-02-30',amount:50};
    expect(()=>bankTransaction(row,'deposit','a')).toThrow('date');
    expect(()=>bankTransaction({...row,amount:-50},'deposit','a')).toThrow('amount');
  });
  it('imports privately and a second sync does not duplicate records',()=>{
    const f=fixture(); f.run(f.ctx);f.run(f.ctx);
    expect(f.data.account).toHaveLength(1);expect(f.data.txn).toHaveLength(1);
    expect(f.data.account[0]).toMatchObject({ownerPersonId:1n,isJoint:false,balanceCents:420000n});
    expect(f.data.spendProfile).toHaveLength(1);
    expect(f.calls[0]).toContain('/customers/customer1/accounts');
  });
  it('rejects an unmapped member before making HTTP requests',()=>{
    const f=fixture();f.tx.me.person.personaKey='sam';expect(()=>f.run(f.ctx)).toThrow('not configured');expect(f.calls).toHaveLength(0);
  });
  it('cannot import an account already owned by another person',()=>{
    const f=fixture();f.data.account=[{id:3n,householdId:2n,ownerPersonId:9n,isJoint:false,nessieId:'bank1'}];
    expect(()=>f.run(f.ctx)).toThrow('another member');expect(f.data.txn).toBeUndefined();
  });
  it('does not write local records when a provider fetch fails',()=>{
    const f=fixture();f.ctx.http.fetch=()=>({status:503,text:()=>''});expect(()=>f.run(f.ctx)).toThrow('HTTP 503');expect(f.data.account).toBeUndefined();
  });
  it('accepts the provider-specific empty transfer response but rejects other 404s',()=>{
    const get=nessieClient({fetch:()=>({status:404,text:()=>JSON.stringify('No transfers found for this account')})},'https://example.test','test');
    expect(get('/accounts/a/transfers')).toEqual([]);
    expect(()=>get('/accounts/a/deposits')).toThrow('HTTP 404');
  });
  it('never includes the secret or provider response in error text',()=>{
    const get=nessieClient({fetch:()=>({status:401,text:()=> 'secret-test'})},'https://example.test','secret-test');
    expect(()=>get('/accounts')).toThrow('Nessie returned HTTP 401. Check server configuration.');
  });
});
