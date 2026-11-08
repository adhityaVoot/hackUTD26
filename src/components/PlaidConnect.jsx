import React,{useEffect,useState} from 'react';
import {useHousehold} from '../HouseholdSession';

function textOf(value){
 if(typeof value==='string')return value;
 if(value&&typeof value==='object')return value.result||value.return||JSON.stringify(value);
 return String(value??'');
}
function loadPlaid(){
 if(window.Plaid)return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  script.src='https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  script.onload=()=>resolve();
  script.onerror=()=>reject(Error('Plaid could not load. Check the network and try again.'));
  document.head.appendChild(script);
 });
}

export default function PlaidConnect(){
 const s=useHousehold();
 const [mode,setMode]=useState('');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [error,setError]=useState('');
 const demo=mode==='sandbox';
 async function loadSandbox(){
  setBusy(true);setError('');setMessage('');
  try{
   const result=JSON.parse(textOf(await s.act('import_sandbox_bank')));
   setMessage(result.newTransactions?`First Platypus Bank is connected. ${result.accounts} accounts, ${result.newTransactions} new transactions.`:`First Platypus Bank is connected. ${result.accounts} accounts are visible. Refresh once if transactions are still preparing.`);
   return true;
  }catch(e){setError(e.message);return false;}finally{setBusy(false);}
 }
 useEffect(()=>{
  if(!s.member||!s.ready)return;
  let cancel=false;
  s.act('bank_connection_mode').then(value=>{if(!cancel)setMode(textOf(value));}).catch(e=>{if(!cancel)setError(e.message);});
  return ()=>{cancel=true;};
 },[s.member?.personId,s.ready]);
 useEffect(()=>{
  if(mode!=='sandbox'||!s.member)return;
  const key=`plaid-sandbox-${s.member.householdId}-${s.member.personId}`;
  if(sessionStorage.getItem(key))return;
  sessionStorage.setItem(key,'1');
  loadSandbox().then(ok=>{if(!ok)sessionStorage.removeItem(key);});
 },[mode,s.member?.personId]);
 async function connect(){
  setBusy(true);setError('');setMessage('');
  try{
   const token=textOf(await s.act('create_plaid_link_token'));
   await loadPlaid();
   await new Promise((resolve,reject)=>{
    const link=window.Plaid.create({
     token,
     onSuccess:async(publicToken,metadata)=>{
      try{
       const result=JSON.parse(textOf(await s.act('connect_plaid_bank',{publicToken,institutionName:metadata?.institution?.name||'Bank'})));
       setMessage(`${result.institution} is connected. ${result.accounts} accounts, ${result.newTransactions} new transactions.`);
       resolve();
      }catch(e){reject(e);}
     },
     onExit:err=>{if(err)reject(Error(err.display_message||err.error_message||'Bank connection closed.'));else resolve();},
    });
    link.open();
   });
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 if(!s.member)return null;
 return <section className="simple-card" aria-label="Connect a bank" style={{marginBottom:20}}>
  <span className="simple-eyebrow">{demo?'PLAID SANDBOX · FIRST PLATYPUS BANK':'PLAID · YOUR BANKS'}</span>
  <h2>{demo?'Demo bank data':'Connect your banks'}</h2>
  <p>{demo?'The Patel demo loads First Platypus Bank, Plaid’s test institution. No real bank login is used.':'Sign in at your bank through Plaid. Tandem then shows the accounts, balances, and recent transactions from that login.'}</p>
  <button className="workspace-button" onClick={demo?loadSandbox:connect} disabled={busy||!s.online||!s.ready||!mode}>{busy?'Connecting…':demo?'Refresh sandbox accounts':'Connect a bank'}</button>
  {message&&<p role="status">{message}</p>}
  {error&&<p className="workspace-error" role="alert">{error}</p>}
 </section>;
}
