import React,{createContext,useContext,useState,lazy,Suspense,useEffect} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {MessageCircle,Minimize2,Maximize2,X,Users} from 'lucide-react';
import {useHousehold} from '../HouseholdSession';
import './assistant-dock.css';
const Mediator=lazy(()=>import('./FamilyMediator'));
const Context=createContext(()=>{});
export const useAssistant=()=>useContext(Context);
export function AssistantProvider({children}){
 const s=useHousehold();const [mode,setMode]=useState('mediator'),[open,setOpen]=useState(false),[expanded,setExpanded]=useState(false),[route,setRoute]=useState(location.hash);
 useEffect(()=>{const sync=()=>setRoute(location.hash);addEventListener('hashchange',sync);return()=>removeEventListener('hashchange',sync)},[]);
 const launch=()=>{setMode('mediator');setOpen(true)};
 return <Context.Provider value={launch}>{children}{s.member&&route&&<><button className="assistant-launcher" onClick={()=>setOpen(v=>!v)} aria-expanded={open}><Users size={20}/>{open?'Minimize mediator':'Family mediator'}</button><Dialog.Root open={open} modal={false} onOpenChange={setOpen}><Dialog.Portal forceMount><Dialog.Content forceMount hidden={!open} className={'assistant-dock '+(expanded?'expanded':'')} onInteractOutside={e=>e.preventDefault()} aria-describedby="assistant-description"><header><div><Dialog.Title>Family mediator</Dialog.Title><Dialog.Description id="assistant-description">Review proposed plans together and find a middle path.</Dialog.Description></div><button aria-label={expanded?'Restore panel size':'Expand panel'} onClick={()=>setExpanded(v=>!v)}>{expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button><button aria-label="Minimize mediator" onClick={()=>setOpen(false)}><X size={18}/></button></header><div className="assistant-body"><Suspense fallback={<p>Loading assistant…</p>}><Mediator/></Suspense></div></Dialog.Content></Dialog.Portal></Dialog.Root></>}</Context.Provider>;
}
