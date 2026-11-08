import { table,t,SenderError } from 'spacetimedb/server';
import { requireMember,requireStepUp,type Ctx } from './auth';
import { simDayToIso } from './engine/calendar';
export const ageProfile=table({name:'age_profile'},{personId:t.u64().primaryKey(),householdId:t.u64().index('btree'),birthDate:t.string()});
export const accountPrivacy=table({name:'account_privacy'},{accountId:t.u64().primaryKey(),householdId:t.u64().index('btree'),ownerAccessDisabled:t.bool()});
export function isMinor(birthDate:string|undefined,onDate:string){if(!birthDate)return false;const age=Number(onDate.slice(0,4))-Number(birthDate.slice(0,4))-(onDate.slice(5)<birthDate.slice(5)?1:0);return age<18;}
export function setBirthDate(ctx:Ctx,personId:bigint,birthDate:string){
 const me=requireMember(ctx);requireStepUp(ctx,me);const person=ctx.db.person.id.find(personId);
 if(!person||person.householdId!==me.household.id)throw new SenderError('Member not found');
 const date=simDayToIso(me.household.simDay),existing=ctx.db.ageProfile.personId.find(personId);
 if(personId!==me.person.id&&(me.person.role!=='coowner'||(existing&&!isMinor(existing.birthDate,date))))throw new SenderError('Only an adult can update their own recorded birth date');
 if(personId===me.person.id&&isMinor(existing?.birthDate,date))throw new SenderError('A household owner must update a minor’s birth date');
 const parsed=new Date(birthDate+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==birthDate||birthDate>date||birthDate<'1900-01-01')throw new SenderError('Enter a valid birth date before the simulation date');
 const row={personId,householdId:me.household.id,birthDate};if(existing)ctx.db.ageProfile.personId.update(row);else ctx.db.ageProfile.insert(row);
 ctx.db.consentLog.insert({id:0n,householdId:me.household.id,actorPersonId:me.person.id,accountId:0n,action:'age_profile_updated',detail:'Updated age profile for member '+personId,at:ctx.timestamp});
}
export function setOwnerAccess(ctx:Ctx,accountId:bigint,allowed:boolean){
 const me=requireMember(ctx);requireStepUp(ctx,me);const account=ctx.db.account.id.find(accountId);
 if(!account||account.householdId!==me.household.id||account.ownerPersonId!==me.person.id||account.isJoint)throw new SenderError('Only the owner of an individual account can change this setting');
 if(!allowed&&isMinor(ctx.db.ageProfile.personId.find(me.person.id)?.birthDate,simDayToIso(me.household.simDay)))throw new SenderError('Owner access is required for members under 18');
 const row={accountId,householdId:me.household.id,ownerAccessDisabled:!allowed};if(ctx.db.accountPrivacy.accountId.find(accountId))ctx.db.accountPrivacy.accountId.update(row);else ctx.db.accountPrivacy.insert(row);
 ctx.db.consentLog.insert({id:0n,householdId:me.household.id,actorPersonId:me.person.id,accountId,action:allowed?'owner_access_allowed':'owner_access_disabled',detail:allowed?'Household owners may view this account and transactions':'Household owner access disabled for this adult account',at:ctx.timestamp});
}
