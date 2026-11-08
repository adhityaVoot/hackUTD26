import React,{useEffect,useState} from 'react';
import {Pencil,Check,X} from 'lucide-react';
import {useHousehold} from '../HouseholdSession';
const same=(a,b)=>String(a)===String(b);
export default function AccountNameEditor({account}){
 const s=useHousehold();const [editing,setEditing]=useState(false),[name,setName]=useState(account.nickname),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 useEffect(()=>{setName(account.nickname);setEditing(false);setError('');setSaved(false)},[account.id,account.nickname]);
 const canEdit=same(account.ownerPersonId,s.member?.personId)||(account.isJoint&&['owner','coowner','admin'].includes(s.member?.role));
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{await s.act('rename_account',{accountId:account.id,nickname:name.trim()});setEditing(false);setSaved(true)}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <div className="account-name-editor">{editing?<form onSubmit={submit}><label htmlFor="account-display-name">Account name</label><div><input id="account-display-name" required autoFocus maxLength={60} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/><button type="submit" className="workspace-button" disabled={busy||!name.trim()}><Check size={16}/>{busy?'Saving…':'Save'}</button><button type="button" className="workspace-button secondary" disabled={busy} onClick={()=>{setEditing(false);setName(account.nickname)}} aria-label="Cancel rename"><X size={16}/></button></div></form>:<div className="account-name-heading"><h2>{account.nickname}</h2>{canEdit&&<button className="account-rename" onClick={()=>{setEditing(true);setSaved(false)}} aria-label={'Rename '+account.nickname}><Pencil size={14}/>Rename</button>}</div>}{error&&<p className="workspace-error" role="alert">{error}</p>}{saved&&<small role="status">Account name saved.</small>}</div>;
}
