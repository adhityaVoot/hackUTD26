import React,{createContext,useContext} from 'react';
const Context=createContext(()=>{});
export const useAssistant=()=>useContext(Context);
export function AssistantProvider({children}){
 return <Context.Provider value={()=>{}}>{children}</Context.Provider>;
}
