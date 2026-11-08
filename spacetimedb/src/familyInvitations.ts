import {table,t,SenderError} from 'spacetimedb/server';
import {ScheduleAt,TimeDuration} from 'spacetimedb';
import {requireCoOwner,requireStepUp,demoPinDigest,type Ctx} from './auth';
import {timestampAt} from './time';
import type Database from './index';
export const authenticatedEmail=table({name:'authenticated_email'},{identity:t.identity().primaryKey(),email:t.string().index('btree')});
export const householdAccess=table({name:'household_access'},{householdId:t.u64().primaryKey(),invitationOnly:t.bool()});
export const personIdentity=table({name:'person_identity'},{personId:t.u64().primaryKey(),identity:t.identity().unique(),householdId:t.u64().index('btree')});
export const familyInvitation=table({name:'family_invitation'},{id:t.u64().primaryKey().autoInc(),householdId:t.u64().index('btree'),inviterPersonId:t.u64(),email:t.string().index('btree'),displayName:t.string(),role:t.string(),status:t.string(),deliveryStatus:t.string(),attempt:t.u32(),createdAt:t.timestamp(),expiresAt:t.timestamp(),lastSendAt:t.timestamp()});
export const invitationEmailJob=table({name:'invitation_email_job'},{scheduledId:t.u64().primaryKey().autoInc(),scheduledAt:t.scheduleAt(),invitationId:t.u64(),attempt:t.u32()});
const ISSUER='https://auth.spacetimedb.com/oidc';
export function verifiedEmail(ctx: Pick<Ctx,'senderAuth'|'env'>):string{
 const jwt=ctx.senderAuth?.jwt;const expected=ctx.env.AUTH_CLIENT_ID||'client_034tn4mKpPebmrzFj9lznr';
 const p=jwt?.fullPayload;
 if(!jwt||jwt.issuer!==ISSUER||!jwt.audience.includes(expected)||p?.email_verified!==true||typeof p.email!=='string')throw new SenderError('Sign in with a verified email address through SpacetimeAuth');
 return p.email.trim().toLowerCase();
}
export function recordAuthenticatedEmail(ctx:Ctx){
 if(ctx.senderAuth?.jwt?.issuer!==ISSUER)return;
 let email;try{email=verifiedEmail(ctx)}catch{ctx.db.authenticatedEmail.identity.delete(ctx.sender);return}const row={identity:ctx.sender,email};
 if(ctx.db.authenticatedEmail.identity.find(ctx.sender))ctx.db.authenticatedEmail.identity.update(row);else ctx.db.authenticatedEmail.insert(row);
}
export function protectAuthenticatedHousehold(ctx:Ctx,householdId:bigint,personId:bigint){
 if(ctx.senderAuth?.jwt?.issuer!==ISSUER)return;
 verifiedEmail(ctx);recordAuthenticatedEmail(ctx);
 ctx.db.householdAccess.insert({householdId,invitationOnly:true});
 ctx.db.personIdentity.insert({personId,householdId,identity:ctx.sender});
}
function audit(ctx:Ctx,householdId:bigint,personId:bigint,action:string){ctx.db.consentLog.insert({id:0n,householdId,actorPersonId:personId,accountId:0n,action,detail:'Family invitation updated',at:ctx.timestamp});}
function queue(ctx:Ctx,row:any){
 const configured=!!ctx.env.RESEND_API_KEY&&!!ctx.env.INVITE_FROM_EMAIL;
 const updated={...row,attempt:row.attempt+1,lastSendAt:ctx.timestamp,deliveryStatus:configured?'queued':'not_configured'};
 ctx.db.familyInvitation.id.update(updated);
 if(configured)ctx.db.invitationEmailJob.insert({scheduledId:0n,scheduledAt:ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch),invitationId:row.id,attempt:updated.attempt});
}
export function inviteFamilyMember(ctx:Ctx,email:string,displayName:string,role:string){
 const me=requireCoOwner(ctx);requireStepUp(ctx,me);const mine=verifiedEmail(ctx);recordAuthenticatedEmail(ctx);
 if(!ctx.db.householdAccess.householdId.find(me.household.id)?.invitationOnly)protectAuthenticatedHousehold(ctx,me.household.id,me.person.id);
 const address=email.trim().toLowerCase(),name=displayName.trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)||address.length>254||address===mine)throw new SenderError('Enter another family member’s email address');
 if(!name||name.length>80||!['member','coowner'].includes(role))throw new SenderError('Choose a name and a valid household role');
 const pending=[...ctx.db.familyInvitation.householdId.filter(me.household.id)].filter(i=>i.status==='pending'&&i.expiresAt.microsSinceUnixEpoch>ctx.timestamp.microsSinceUnixEpoch);
 if(pending.some(i=>i.email===address))throw new SenderError('An invitation is already pending for this email');
 if(pending.length>=10)throw new SenderError('Resolve an existing invitation before sending another');
 const row=ctx.db.familyInvitation.insert({id:0n,householdId:me.household.id,inviterPersonId:me.person.id,email:address,displayName:name,role,status:'pending',deliveryStatus:'not_sent',attempt:0,createdAt:ctx.timestamp,expiresAt:timestampAt(ctx.timestamp,ctx.timestamp.microsSinceUnixEpoch+7n*86400n*1000000n),lastSendAt:ctx.timestamp});
 queue(ctx,row);audit(ctx,me.household.id,me.person.id,'family_invitation_created');
}
export function acceptFamilyInvitation(ctx:Ctx,invitationId:bigint,pin:string){
 const email=verifiedEmail(ctx),invite=ctx.db.familyInvitation.id.find(invitationId);
 if(!invite||invite.email!==email||invite.status!=='pending'||invite.expiresAt.microsSinceUnixEpoch<=ctx.timestamp.microsSinceUnixEpoch)throw new SenderError('This invitation is not available for your signed-in email');
 if(ctx.db.member.identity.find(ctx.sender)||ctx.db.personIdentity.identity.find(ctx.sender))throw new SenderError('You already belong to a household. Switching households is not supported yet');
 if(!/^\d{4}$/.test(pin))throw new SenderError('Create a four-digit PIN');
 const household=ctx.db.household.id.find(invite.householdId);if(!household)throw new SenderError('Household no longer exists');
 const person=ctx.db.person.insert({id:0n,householdId:invite.householdId,displayName:invite.displayName,role:invite.role,personaKey:'invited-'+String(invite.id),pinHash:''});
 ctx.db.person.id.update({...person,pinHash:demoPinDigest(person.id,pin)});
 ctx.db.personIdentity.insert({personId:person.id,householdId:household.id,identity:ctx.sender});
 recordAuthenticatedEmail(ctx);
 ctx.db.member.insert({identity:ctx.sender,householdId:household.id,personId:person.id,kind:'person',online:true,lastActiveAt:ctx.timestamp,stepUpAt:ctx.timestamp,pinFailCount:0,pinFailWindowStartMicros:0n,pinLockedUntilMicros:0n});
 ctx.db.familyInvitation.id.update({...invite,status:'accepted'});audit(ctx,household.id,person.id,'family_invitation_accepted');
}
export function registerInvitations(db:typeof Database){
 const inviteFamily=db.reducer({email:t.string(),displayName:t.string(),role:t.string()},(ctx,a)=>inviteFamilyMember(ctx,a.email,a.displayName,a.role));
 const acceptFamily=db.reducer({invitationId:t.u64(),pin:t.string()},(ctx,a)=>acceptFamilyInvitation(ctx,a.invitationId,a.pin));
 const declineFamily=db.reducer({invitationId:t.u64()},(ctx,a)=>{const email=verifiedEmail(ctx),row=ctx.db.familyInvitation.id.find(a.invitationId);if(!row||row.email!==email||row.status!=='pending')throw new SenderError('Invitation unavailable');ctx.db.familyInvitation.id.update({...row,status:'declined'});});
 const revokeFamily=db.reducer({invitationId:t.u64()},(ctx,a)=>{const me=requireCoOwner(ctx),row=ctx.db.familyInvitation.id.find(a.invitationId);requireStepUp(ctx,me);if(!row||row.householdId!==me.household.id||row.status!=='pending')throw new SenderError('Invitation unavailable');ctx.db.familyInvitation.id.update({...row,status:'revoked'});audit(ctx,me.household.id,me.person.id,'family_invitation_revoked');});
 const resendFamily=db.reducer({invitationId:t.u64()},(ctx,a)=>{const me=requireCoOwner(ctx),row=ctx.db.familyInvitation.id.find(a.invitationId);requireStepUp(ctx,me);verifiedEmail(ctx);if(!row||row.householdId!==me.household.id||row.status!=='pending'||row.expiresAt.microsSinceUnixEpoch<=ctx.timestamp.microsSinceUnixEpoch)throw new SenderError('Invitation unavailable');if(ctx.timestamp.microsSinceUnixEpoch-row.lastSendAt.microsSinceUnixEpoch<60_000_000n)throw new SenderError('Wait a minute before resending');if(row.attempt>=5)throw new SenderError('Revoke this invitation before creating a new one');queue(ctx,row);});
 const invitationSettings=db.view({name:'my_invitation_settings',public:true},t.array(t.row('InvitationSettings',{id:t.u64().primaryKey(),invitationOnly:t.bool(),emailDeliveryReady:t.bool(),email:t.string()})),ctx=>{const member=ctx.db.member.identity.find(ctx.sender),email=ctx.db.authenticatedEmail.identity.find(ctx.sender)?.email||'';return [{id:0n,email,invitationOnly:member?ctx.db.householdAccess.householdId.find(member.householdId)?.invitationOnly??false:false,emailDeliveryReady:!!ctx.env.RESEND_API_KEY&&!!ctx.env.INVITE_FROM_EMAIL}];});
 const outgoing=db.view({name:'household_invitations',public:true},t.array(familyInvitation.rowType),ctx=>{const m=ctx.db.member.identity.find(ctx.sender);if(!m||ctx.db.person.id.find(m.personId)?.role!=='coowner')return [];return [...ctx.db.familyInvitation.householdId.filter(m.householdId)];});
 const inbox=db.view({name:'my_family_invitations',public:true},t.array(t.row('FamilyInviteInbox',{id:t.u64().primaryKey(),householdName:t.string(),inviterName:t.string(),displayName:t.string(),role:t.string(),expiresAt:t.timestamp()})),ctx=>{const email=ctx.db.authenticatedEmail.identity.find(ctx.sender)?.email;if(!email)return [];return [...ctx.db.familyInvitation.email.filter(email)].filter(i=>i.status==='pending').map(i=>({id:i.id,householdName:ctx.db.household.id.find(i.householdId)?.name||'Household',inviterName:ctx.db.person.id.find(i.inviterPersonId)?.displayName||'Household owner',displayName:i.displayName,role:i.role,expiresAt:i.expiresAt}));});
 const sendEmail=db.procedure({onSchedule:invitationEmailJob},{job:invitationEmailJob.rowType},t.unit(),(ctx,{job})=>{
  const loaded=ctx.withTx(tx=>{if(!tx.senderAuth.isInternal)throw new SenderError('Invitation delivery runs on a schedule');const row=tx.db.familyInvitation.id.find(job.invitationId);if(!row||row.status!=='pending'||row.attempt!==job.attempt||row.deliveryStatus!=='queued'||row.expiresAt.microsSinceUnixEpoch<=tx.timestamp.microsSinceUnixEpoch)return null;tx.db.familyInvitation.id.update({...row,deliveryStatus:'sending'});return {row,key:tx.env.RESEND_API_KEY,from:tx.env.INVITE_FROM_EMAIL,url:tx.env.APP_PUBLIC_URL||'https://tandem-app.us',household:tx.db.household.id.find(row.householdId)?.name||'your household',inviter:tx.db.person.id.find(row.inviterPersonId)?.displayName||'A household owner'};});
  if(!loaded)return {};
  let status='failed';try{const url=new URL(loaded.url);if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Invalid app URL');const response=ctx.http.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+loaded.key,'Content-Type':'application/json','Idempotency-Key':`tandem-${loaded.row.createdAt.microsSinceUnixEpoch}-${loaded.row.id}-${loaded.row.attempt}`},body:JSON.stringify({from:loaded.from,to:[loaded.row.email],subject:`Invitation to join ${loaded.household} on Tandem`,text:`${loaded.inviter} invited you to join ${loaded.household} as a ${loaded.row.role}.\n\nSign in with ${loaded.row.email}, then review and accept your invitation:\n${url.origin}/#signin\n\nYou will not join or share any accounts until you accept. This invitation expires in 7 days.`}),timeout:TimeDuration.fromMillis(15000)});if(response.status>=200&&response.status<300)status='sent';}catch{/* Never log a provider response, recipient details, or credentials. */}
  ctx.withTx(tx=>{const row=tx.db.familyInvitation.id.find(job.invitationId);if(row&&row.attempt===job.attempt)tx.db.familyInvitation.id.update({...row,deliveryStatus:status});});return {};
 });
 return {inviteFamily,acceptFamily,declineFamily,revokeFamily,resendFamily,invitationSettings,outgoing,inbox,sendEmail};
}
