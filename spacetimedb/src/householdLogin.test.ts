import {describe,it,expect} from 'vitest';
import {Identity,Timestamp} from 'spacetimedb';
import {joinHouseholdWithPin} from './index';
import {demoPinDigest} from './auth';
function fixture(pin='1234'){
 let person:any={id:2n,householdId:7n,displayName:'Priya',personaKey:'priya',pinHash:pin?demoPinDigest(2n,pin):''};let member:any;let mutations=0;
 const ctx:any={sender:new Identity(99n),timestamp:new Timestamp(1800000000000000n),db:{householdAccess:{householdId:{find:()=>undefined}},household:{inviteCode:{find:(code:string)=>code==='PATELS'?{id:7n,inviteCode:'PATELS'}:undefined}},person:{householdId:{filter:()=>[person]},id:{update:(p:any)=>{person=p;mutations++}}},member:{personId:{filter:()=>[]},identity:{find:()=>member,update:(m:any)=>{member=m;mutations++},delete:()=>{mutations++}},insert:(m:any)=>{member=m;mutations++}},consentLog:{insert:()=>{mutations++}}}};
 return {ctx,member:()=>member,person:()=>person,mutations:()=>mutations};
}
describe('household PIN sign-in',()=>{
 it('does not create membership or make any changes for a wrong PIN',()=>{const f=fixture();expect(()=>joinHouseholdWithPin(f.ctx,{inviteCode:'PATELS',name:'priya',pin:'9999',createPin:false})).toThrow('Check your name');expect(f.member()).toBeUndefined();expect(f.mutations()).toBe(0);});
 it('connects membership only after the correct PIN is checked',()=>{const f=fixture();joinHouseholdWithPin(f.ctx,{inviteCode:'PATELS',name:'Priya',pin:'1234',createPin:false});expect(f.member()).toMatchObject({personId:2n,householdId:7n,stepUpAt:f.ctx.timestamp});});
 it('requires explicit first-visit setup for a member with no PIN',()=>{const f=fixture('');expect(()=>joinHouseholdWithPin(f.ctx,{inviteCode:'PATELS',name:'priya',pin:'1234',createPin:false})).toThrow('First visit');expect(f.mutations()).toBe(0);joinHouseholdWithPin(f.ctx,{inviteCode:'PATELS',name:'priya',pin:'1234',createPin:true});expect(f.person().pinHash).toBe(demoPinDigest(2n,'1234'));});
 it('cannot reset an existing PIN through the first-visit option',()=>{const f=fixture();expect(()=>joinHouseholdWithPin(f.ctx,{inviteCode:'PATELS',name:'priya',pin:'9999',createPin:true})).toThrow();expect(f.mutations()).toBe(0);});
});
