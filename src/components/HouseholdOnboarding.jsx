import {PendingFamilyInvitations} from './FamilyInvitations';
import React,{useState} from 'react';
import {ShieldCheck,Users,Plus} from 'lucide-react';
import {useIdentityAuth} from '../IdentityAuth';
import {useHousehold,JoinHousehold} from '../HouseholdSession';
export default function HouseholdOnboarding(){
 const auth=useIdentityAuth(),s=useHousehold();const [setup,setSetup]=useState(null);
 const name=auth.user?.profile?.given_name||auth.user?.profile?.name||'to Tandem';
 return <><PendingFamilyInvitations/><section className="simple-card onboarding-welcome"><span className="simple-eyebrow"><ShieldCheck size={15}/> SIGNED IN</span><h2>Welcome {name}</h2><p>{auth.user?.profile?.email}</p><p>Your sign-in is complete. Create your own household or join one you have been invited to.</p><div className="onboarding-actions"><button className="workspace-button" onClick={()=>setSetup('create')} disabled={!s.online||!s.ready}><Plus size={17}/>Create a household</button><p className="workspace-copy">To join an existing family, ask its owner to invite your signed-in email. Your invitation will appear above.</p></div><p className="workspace-small">Your new workspace starts empty. No sample bank accounts, balances, or transactions are added.</p>{s.error&&<p className="workspace-error" role="alert">{s.error}</p>}{setup&&<JoinHousehold key={setup} initialCreate={setup==='create'} onClose={()=>setSetup(null)}/>}</section></>;
}
