import {describe,it,expect} from 'vitest';
import {isMinor} from './accountPrivacy';
import {canSee,readMyTxns,readMyForecast} from './visibility';
function fixture(){
 const profiles=new Map<bigint,any>([[2n,{birthDate:'2000-01-01'}]]);const policies=new Map<bigint,any>();
 const account:any={id:10n,householdId:7n,ownerPersonId:2n,isJoint:false};const me:any={personId:1n,householdId:7n,kind:'person'};
 const ctx:any={sender:{toHexString:()=>''},db:{person:{id:{find:(id:bigint)=>({id,role:id===1n?'coowner':'member'})}},ageProfile:{personId:{find:(id:bigint)=>profiles.get(id)}},accountPrivacy:{accountId:{find:(id:bigint)=>policies.get(id)}},household:{id:{find:()=>({simDay:0})}},grant:{accountId:{filter:()=>[]}},account:{householdId:{filter:()=>[account]}},member:{identity:{find:()=>me}},txn:{accountId:{filter:()=>[{id:1n,accountId:10n,day:0,amountCents:-100n,category:'other',merchantCode:'TEST',rawDescription:'Test'}]}},scenario:{householdId:{filter:()=>[{id:1n,scope:'household'}]}},forecastDay:{householdId:{filter:()=>[{scenarioId:1n,accountId:0n},{scenarioId:1n,accountId:10n}]}}}};
 return {ctx,account,me,profiles,policies};
}
describe('household owner account visibility',()=>{
 it('uses the birthday boundary and treats unknown ages as adults',()=>{expect(isMinor(undefined,'2026-11-01')).toBe(false);expect(isMinor('2008-11-02','2026-11-01')).toBe(true);expect(isMinor('2008-11-02','2026-11-02')).toBe(false);});
 it('gives owners default full access to adult accounts and transactions',()=>{const f=fixture();expect(canSee(f.ctx,f.me,f.account)).toBe('full');expect(readMyTxns(f.ctx)).toHaveLength(1);});
 it('hides opted-out adult accounts, transactions, and household aggregate forecasts',()=>{const f=fixture();f.policies.set(10n,{ownerAccessDisabled:true});expect(canSee(f.ctx,f.me,f.account)).toBe('none');expect(readMyTxns(f.ctx)).toHaveLength(0);expect(readMyForecast(f.ctx)).toHaveLength(0);});
 it('keeps minor accounts supervised even when an old opt-out exists',()=>{const f=fixture();f.profiles.set(2n,{birthDate:'2009-01-01'});f.policies.set(10n,{ownerAccessDisabled:true});expect(canSee(f.ctx,f.me,f.account)).toBe('full');expect(readMyTxns(f.ctx)).toHaveLength(1);});
 it('does not grant supervisory access to an ordinary member',()=>{const f=fixture();f.me.personId=3n;expect(canSee(f.ctx,f.me,f.account)).toBe('none');});
 it('always preserves the individual account owner’s own access',()=>{const f=fixture();f.me.personId=2n;f.policies.set(10n,{ownerAccessDisabled:true});expect(canSee(f.ctx,f.me,f.account)).toBe('full');});
});
