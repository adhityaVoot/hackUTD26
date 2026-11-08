import React,{useState} from 'react';
import {Eye,EyeOff} from 'lucide-react';
export default function PinField({id,value,onChange,disabled,autoComplete='off',inputClassName,ariaLabel,required=true}){
 const [visible,setVisible]=useState(false);
 return <span className="pin-field"><input id={id} className={inputClassName} aria-label={ariaLabel} required={required} type={visible?'text':'password'} inputMode="numeric" pattern="[0-9]{4}" minLength={required?4:undefined} maxLength={4} autoComplete={autoComplete} value={value} disabled={disabled} onChange={e=>onChange(e.target.value.replace(/\D/g,'').slice(0,4))}/><button type="button" className="pin-reveal" aria-label={visible?'Hide PIN':'Show PIN'} aria-pressed={visible} disabled={disabled} onClick={()=>setVisible(v=>!v)}>{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button></span>;
}
