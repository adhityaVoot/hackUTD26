import {describe,it,expect,vi} from 'vitest';
vi.mock('./auth',()=>({requireMember:(ctx:any)=>ctx.me,requireStepUp:(ctx:any)=>{if(!ctx.verified)throw Error('PIN required');}}));
import {createMoneyRequest,respondMoneyRequest} from './moneyRequests';
function fixture(){
 const requests:any[]=[];const people=[{id:1n,householdId:7n},{id:2n,householdId:7n},{id:3n,householdId:8n}];const log:any[]=[];
 const ctx:any={me:{person:{id:1n},household:{id:7n}},timestamp:{},verified:false,db:{person:{id:{find:(id:bigint)=>people.find(p=>p.id===id)}},moneyRequest:{insert:(r:any)=>requests.push({...r,id:1n}),id:{find:(id:bigint)=>requests.find(r=>r.id===id),update:(r:any)=>requests[requests.findIndex(x=>x.id===r.id)]=r}},consentLog:{insert:(r:any)=>log.push(r)}}};
 return {ctx,requests,log};
}
describe('family money requests',()=>{
 it('persists the amount, reason, and both participants',()=>{const {ctx,requests}=fixture();createMoneyRequest(ctx,2n,50000n,'Car repair');expect(requests[0]).toMatchObject({requesterPersonId:1n,recipientPersonId:2n,amountCents:50000n,reason:'Car repair',status:'pending'});});
 it('rejects self requests, another household, and invalid amounts',()=>{const {ctx}=fixture();expect(()=>createMoneyRequest(ctx,1n,100n,'Test')).toThrow();expect(()=>createMoneyRequest(ctx,3n,100n,'Test')).toThrow();expect(()=>createMoneyRequest(ctx,2n,0n,'Test')).toThrow();});
 it('only the recipient can approve, with a verified PIN',()=>{const {ctx,requests,log}=fixture();createMoneyRequest(ctx,2n,50000n,'Car repair');ctx.verified=true;expect(()=>respondMoneyRequest(ctx,1n,'approve')).toThrow('Only the requested');ctx.me.person.id=2n;ctx.verified=false;expect(()=>respondMoneyRequest(ctx,1n,'approve')).toThrow('PIN');ctx.verified=true;respondMoneyRequest(ctx,1n,'approve');expect(requests[0].status).toBe('approved');expect(log).toHaveLength(1);expect(()=>respondMoneyRequest(ctx,1n,'approve')).toThrow('already');});
 it('lets the requester cancel and the recipient decline',()=>{const a=fixture();createMoneyRequest(a.ctx,2n,100n,'Books');respondMoneyRequest(a.ctx,1n,'cancel');expect(a.requests[0].status).toBe('cancelled');const b=fixture();createMoneyRequest(b.ctx,2n,100n,'Books');b.ctx.me.person.id=2n;respondMoneyRequest(b.ctx,1n,'decline');expect(b.requests[0].status).toBe('declined');});
});
