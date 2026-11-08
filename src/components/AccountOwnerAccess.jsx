import React,{useState} from 'react';
import {ShieldCheck,Lock} from 'lucide-react';
import {useHousehold,PinPad} from '../HouseholdSession';
const same=(a,b)=>String(a)===String(b);
export function AccountOwnerAccess({account}){
 const s=useHousehold();const [pin,setPin]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(account.isJoint||!same(account.ownerPersonId,s.member?.personId))return null;
 const policy=(s.myAccountPrivacy||[]).find(p=>same(p.accountId,account.id));
 async function toggle(){if(Number(s.member?.stepUpValidUntilMicros||0)/1000<=Date.now()){setPin(true);return}setBusy(true);setError('');try{await s.act('set_account_owner_access',{accountId:account.id,allowed:!!policy?.ownerAccessDisabled})}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <section className="simple-card account-owner-access"><h3><ShieldCheck size={18}/>Household owner access</h3><p>{policy?.isMinor?'Members under 18: household owners can view this account and its transactions.':policy?.ownerAccessDisabled?'Private from household owners. Your account and transactions are excluded from their view.':'Household owners can view this account and its transactions. As an adult, you can turn this off.'}</p>{!policy?.isMinor&&<button className="workspace-button secondary" disabled={busy||!policy||!s.ready||!s.online} onClick={toggle}><Lock size={14}/>{busy?'Saving…':policy?.ownerAccessDisabled?'Allow owner access':'Disallow owner access'}</button>}{error&&<p role="alert" className="workspace-error">{error}</p>}{pin&&<PinPad onClose={()=>setPin(false)}/>}</section>;
}
export function FamilyAgeSettings(){
 const s=useHousehold();const [person,setPerson]=useState(''),[birth,setBirth]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[pin,setPin]=useState(false);
 const owner=['owner','coowner','admin'].includes(s.member?.role);const people=owner?s.people:s.people.filter(p=>same(p.id,s.member?.personId));
 async function save(e){e.preventDefault();if(Number(s.member?.stepUpValidUntilMicros||0)/1000<=Date.now()){setPin(true);return}setBusy(true);setNotice('');try{await s.act('set_member_birth_date',{personId:BigInt(person),birthDate:birth});setNotice('Age profile updated. Account access follows the household simulation date.')}catch(e){setNotice(e.message)}finally{setBusy(false)}}
 return <section className="simple-card"><h2>Family age profiles</h2><p>Birth dates determine whether owner access is required. Owners can manage minors’ profiles; adults control their own recorded birth date.</p><form className="workspace-form" onSubmit={save}><label className="workspace-field"><span>Family member</span><select required value={person} onChange={e=>setPerson(e.target.value)}><option value="">Select member</option>{people.map(p=><option key={String(p.id)} value={String(p.id)}>{p.displayName}</option>)}</select></label><label className="workspace-field"><span>Birth date</span><input type="date" required value={birth} onChange={e=>setBirth(e.target.value)}/></label><button className="workspace-button" disabled={busy||!s.online||!s.ready}>{busy?'Saving…':'Save age profile'}</button></form>{notice&&<p role="status">{notice}</p>}{pin&&<PinPad onClose={()=>setPin(false)}/>}</section>;
}
