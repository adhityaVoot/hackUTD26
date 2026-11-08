import React,{useState} from 'react';
import {useHousehold} from '../HouseholdSession';
export default function NessieConnect(){
 const s=useHousehold(); const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 async function sync(){setBusy(true);setError('');setMessage('');try{await s.act('sync_nessie_demo');setMessage('Demo banking sync completed. Your account balances and available transactions will update here.');}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="simple-card" aria-label="Connect demo banking" style={{marginBottom:20}}><span className="simple-eyebrow">CAPITAL ONE NESSIE · SYNTHETIC DATA</span><h2>Connect demo banking</h2><p>Import your own demo checking and savings accounts, balances, and posted transactions. No real bank login or money movement.</p><button className="workspace-button" onClick={sync} disabled={busy||!s.online||!s.ready}>{busy?'Syncing demo accounts…':'Connect / refresh demo accounts'}</button><p className="workspace-small">Demo accounts stay private until you explicitly share them. Credit limits, APRs, and future bills are not supplied by this import; review forecast assumptions after connecting.</p>{message&&<p role="status">{message}</p>}{error&&<p className="workspace-error" role="alert">{error}</p>}</section>;
}
