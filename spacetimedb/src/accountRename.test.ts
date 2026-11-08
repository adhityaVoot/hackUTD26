import {describe,it,expect,vi} from 'vitest';
vi.mock('./auth',()=>({requireMember:(ctx:any)=>ctx.me}));
vi.mock('./recompute',()=>({recomputeScenario:vi.fn()}));
import {renameAccount} from './life';
function fixture(){let row:any={id:10n,householdId:7n,ownerPersonId:2n,isJoint:false,nickname:'Checking',balanceCents:123456n,limitCents:500000n,aprBps:500,bufferCents:20000n};const ctx:any={me:{person:{id:2n,role:'member'},household:{id:7n}},db:{account:{id:{find:()=>row,update:(next:any)=>{row=next}}}}};return {ctx,row:()=>row};}
describe('account renaming',()=>{
 it('updates only the name, preserving every financial field',()=>{const f=fixture(),before={...f.row()};renameAccount(f.ctx,10n,'  Everyday checking  ');expect(f.row()).toEqual({...before,nickname:'Everyday checking'});});
 it('does not let a household co-owner rename another person’s individual account',()=>{const f=fixture();f.ctx.me.person={id:1n,role:'coowner'};expect(()=>renameAccount(f.ctx,10n,'Other')).toThrow('Only the account owner');});
 it('allows co-owners to rename joint accounts but rejects blank names',()=>{const f=fixture();f.row().isJoint=true;f.ctx.me.person.role='coowner';renameAccount(f.ctx,10n,'Household bills');expect(f.row().nickname).toBe('Household bills');expect(()=>renameAccount(f.ctx,10n,'  ')).toThrow('between 1 and 60');});
});
