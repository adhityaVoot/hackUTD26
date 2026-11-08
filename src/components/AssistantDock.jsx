import React,{createContext,useContext,useState,lazy,Suspense,useEffect} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {MessageCircle,Minimize2,Maximize2,X,Users} from 'lucide-react';
import {useHousehold} from '../HouseholdSession';
import './assistant-dock.css';
const Mediator=lazy(()=>import('./FamilyMediator'));
const Coach=lazy(()=>import('./Workspaces').then(m=>({default:m.Coach})));
const Context=createContext(()=>{});
export const useAssistant=()=>useContext(Context);
export function AssistantProvider({children}){
 const s=useHousehold();const [mode,setMode]=useState('coach'),[open,setOpen]=useState(false),[expanded,setExpanded]=useState(false),[route,setRoute]=useState(location.hash);
 useEffect(()=>{const sync=()=>setRoute(location.hash);addEventListener('hashchange',sync);return()=>removeEventListener('hashchange',sync)},[]);
 const launch=next=>{setMode(next||'coach');setOpen(true)};
 return <Context.Provider value={launch}>{children}{s.member&&route&&<><button className="assistant-launcher" onClick={()=>setOpen(v=>!v)} aria-expanded={open}><MessageCircle size={20}/>{open?'Minimize assistant':'Ask Coach'}</button><Dialog.Root open={open} modal={false} onOpenChange={setOpen}><Dialog.Portal forceMount><Dialog.Content forceMount hidden={!open} className={'assistant-dock '+(expanded?'expanded':'')} onInteractOutside={e=>e.preventDefault()} aria-describedby="assistant-description"><header><div><Dialog.Title>{mode==='coach'?'Financial coach':'Family mediator'}</Dialog.Title><Dialog.Description id="assistant-description">Explore your finances and review proposed plans.</Dialog.Description></div><button aria-label={expanded?'Restore panel size':'Expand panel'} onClick={()=>setExpanded(v=>!v)}>{expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button><button aria-label="Minimize assistant" onClick={()=>setOpen(false)}><X size={18}/></button></header><div className="assistant-mode"><button className={mode==='coach'?'active':''} onClick={()=>setMode('coach')}><MessageCircle size={15}/>Coach</button><button className={mode==='mediator'?'active':''} onClick={()=>setMode('mediator')}><Users size={15}/>Mediator</button></div><div className="assistant-body"><Suspense fallback={<p>Loading assistant…</p>}><div hidden={mode!=='coach'}><Coach coachOnly/></div><div hidden={mode!=='mediator'}><Mediator/></div></Suspense></div></Dialog.Content></Dialog.Portal></Dialog.Root></>}</Context.Provider>;
}
