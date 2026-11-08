import React,{useState,useEffect,useRef} from 'react';
import {ResponsiveContainer,LineChart,Line,XAxis,YAxis,Tooltip,CartesianGrid,Legend,ReferenceLine} from 'recharts';
import {ShieldAlert,Waves,HeartPulse,PiggyBank,CalendarClock,Sparkles,CheckCircle2,Search,Calculator,PenLine,ShieldCheck,Route,Bot,Wand2,ListChecks,Scale,ThumbsUp,ThumbsDown,Gavel,MessageCircle,Send,Users,RotateCcw} from 'lucide-react';
import {useHousehold} from '../HouseholdSession';
import './nemotron-lab.css';

// Day 0 of the simulation is Nov 1, 2026 (same epoch as the engine and the rest of the app).
const dayLabel=d=>new Date(Date.UTC(2026,10,1+Number(d))).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
const usd=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(n||0));
const parse=row=>{try{return JSON.parse(row?.resultJson||'{}')}catch{return {}}};
const COLORS=['#6366f1','#f59e0b','#ef4444','#10b981','#0ea5e9'];

/** Baseline vs every simulated future, weekly for 12 months. */
export function ScenarioChart({result,height=220,max=4}){
  const sims=(result?.scenarios||[]).filter(s=>Array.isArray(s.series)&&s.series.length).slice(0,max);
  const base=result?.baselineSeries;
  if(!sims.length||!Array.isArray(base))return null;
  const data=base.map((p,i)=>{const row={label:dayLabel(p.day),baseline:p.balance};sims.forEach((s,k)=>{row['s'+k]=s.series[i]?.balance});return row});
  return <div className="lab-chart" aria-label="Projected household cash for the next 12 months">
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{top:8,right:12,left:4,bottom:0}}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.25}/>
        <XAxis dataKey="label" minTickGap={28} tick={{fontSize:11}}/>
        <YAxis tickFormatter={v=>Math.abs(v)>=1000?`$${Math.round(v/1000)}k`:`$${v}`} width={56} tick={{fontSize:11}}/>
        <Tooltip formatter={v=>usd(v)}/>
        <Legend wrapperStyle={{fontSize:12}}/>
        <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 4"/>
        <Line type="monotone" dataKey="baseline" name="No change" stroke="#94a3b8" strokeWidth={2} dot={false}/>
        {sims.map((s,k)=><Line key={s.simId} type="monotone" dataKey={'s'+k} name={s.title} stroke={COLORS[k%COLORS.length]} strokeWidth={2} dot={false}/>)}
      </LineChart>
    </ResponsiveContainer>
  </div>;
}

// Each logged step belongs to one of the agents in the pipeline.
function roleOf(step,detail){
  if(step==='route')return {role:'Router',Icon:Route};
  if(step==='review')return {role:'Reviewer',Icon:CheckCircle2};
  if(step==='debate'){const who=String(detail).split(':')[0];return {role:who,Icon:who==='Advocate'?ThumbsUp:who==='Skeptic'?ThumbsDown:Gavel}}
  if(step==='tool_call'&&/^lookup_information/.test(detail))return {role:'Researcher',Icon:Search};
  if(step==='simulate'||step==='candidates'||step==='tool_call')return {role:'Analyst',Icon:Calculator};
  if(step==='parse'||step==='verify'||step==='propose'||step==='plan')return {role:'Writer',Icon:PenLine};
  if(step==='pii_scan'||step==='injection_flag'||step==='observe'||step==='prompt_built')return {role:'Guardrails',Icon:ShieldCheck};
  return {role:step==='fallback'?'Fallback':'System',Icon:Bot};
}

/** "How Nemotron worked this out": the hand-offs between agents, from the append-only agent log. */
export function AgentTrace({runId,live=false}){
  const s=useHousehold();
  const steps=(s.myAgentLog||[]).filter(l=>String(l.runId)===String(runId)&&l.step!=='usage').slice().sort((a,b)=>Number(a.id)-Number(b.id));
  if(!steps.length)return null;
  const list=<ol className="lab-trace">{steps.map(l=>{const {role,Icon}=roleOf(l.step,l.detail);return <li key={String(l.id)} className={l.flagged?'flagged':''}><Icon size={14}/><strong>{role}</strong><span>{l.detail}</span></li>})}</ol>;
  if(live)return <div className="lab-live">{list}</div>;
  const roles=[...new Set(steps.map(l=>roleOf(l.step,l.detail).role).filter(r=>!['System','Guardrails'].includes(r)))];
  return <details className="lab-trace-box"><summary>How Nemotron worked this out · {roles.join(' → ')}</summary>{list}</details>;
}

export function ReviewBadge({review}){
  if(!review||review.verdict==='skipped')return null;
  return <span className={'lab-review '+review.verdict} title={(review.issues||[]).join('\n')}><CheckCircle2 size={13}/>{review.verdict==='revised'?'Corrected by the Reviewer agent':'Checked by the Reviewer agent'}</span>;
}

// Every way to ask Nemotron, in one place. "ask" is the conversational coach; the rest run one agent workflow.
const MODES=[
  {key:'ask',label:'Ask',Icon:MessageCircle,op:'ask_coach',field:'message',placeholder:'Ask anything: "I want to buy a Rolex", "Can we afford Japan in March?"',hint:'A conversation. Nemotron checks prices online, runs your numbers, and asks when it needs more.'},
  {key:'debate',label:'Debate it',Icon:Scale,op:'debate_decision',field:'decision',placeholder:'Should we buy a $35,000 car in March?',hint:'An Advocate and a Skeptic argue from your simulation; a Judge decides.'},
  {key:'stress',label:'Stress test',Icon:ShieldAlert,op:'stress_test',field:'scenario',placeholder:'What if Sam loses his job for two months?',hint:'Three severities, the weakest point, and a fix that works.'},
  {key:'ripple',label:'Ripple effect',Icon:Waves,op:'simulate_ripple',field:'decision',placeholder:'Buy a $1,500 laptop next week',hint:'One decision and every knock-on effect, in order.'},
  {key:'life_event',label:'Life event',Icon:CalendarClock,op:'simulate_life_event',field:'event',placeholder:"We're getting married next June",hint:'Dated costs, a savings target, and a checklist.'},
];
export const QUICK=[
  {key:'health',label:'Health check',Icon:HeartPulse,op:'request_health_check'},
  {key:'opportunity',label:'Find savings',Icon:PiggyBank,op:'scan_opportunities'},
  {key:'briefing',label:"What's coming up",Icon:Sparkles,op:'request_briefing'},
];
const FEED_KINDS=new Set(['coach','debate','stress','ripple','life_event','health','opportunity','briefing']);
const VITAL_NAMES={runway:'Cash runway',crunch_risk:'Overdraft risk',dti:'Debt-to-income',utilization:'Card utilization',savings_rate:'Savings rate',goal_track:'Goal track'};
const threadOf=row=>{try{return JSON.parse(row.contextJson||'{}').threadId||String(row.id)}catch{return String(row.id)}};

/** Ask from anywhere in the app: the studio listens and runs it. */
export function askNemotron(mode,text){window.dispatchEvent(new CustomEvent('nemotron:ask',{detail:{mode,text}}))}

/** Turn an agent's simulated plan into a real household proposal (Two-Key co-sign flow). */
function ProposeButtons({result}){
  const s=useHousehold();const [sent,setSent]=useState({}),[busy,setBusy]=useState('');
  const plans=(result?.scenarios||[]).filter(x=>x.proposable&&x.scenarioId);
  if(!plans.length||!s.capabilities?.propose_agent_plan)return null;
  const statusOf=id=>(s.householdScenarios||[]).find(x=>String(x.id)===String(id))?.status;
  const label=(p,st,done)=>st==='merged'?`Applied: ${p.title} (no approval needed)`:st==='proposed'||done?`Sent for approval: ${p.title}`:`Send "${p.title}" for approval`;
  return <div className="lab-propose">{plans.slice(0,3).map(p=>{const st=statusOf(p.scenarioId);const done=sent[p.scenarioId]||(st&&st!=='draft');
    return <button key={p.scenarioId} className={'lab-propose-btn'+(st==='merged'?' applied':'')} disabled={!!done||busy===p.scenarioId} onClick={async()=>{setBusy(p.scenarioId);try{await s.act('propose_agent_plan',{scenarioId:BigInt(p.scenarioId)});setSent(v=>({...v,[p.scenarioId]:true}))}catch{}finally{setBusy('')}}}>
      {st==='merged'?<CheckCircle2 size={14}/>:<Users size={14}/>}{busy===p.scenarioId?'Sending…':label(p,st,done)}</button>})}</div>;
}

/** One answer, rendered for what it is: a chat reply, a debate, a stress test, vitals, savings... */
function Reply({row}){
  const r=parse(row);const kind=r.kind||row.kind;const extra=r.extra||{};
  if(row.status==='thinking')return <div className="lab-result thinking"><p><Wand2 size={15}/> Nemotron agents are working on this…</p><AgentTrace runId={row.runId} live/></div>;
  return <div className={'lab-result kind-'+kind}>
    {kind!=='coach'&&kind!=='clarify'&&kind!=='twin'&&<div className="lab-result-head"><h4>{r.title}</h4><ReviewBadge review={r.review}/></div>}
    <p className="lab-answer">{r.answer||'No answer came back.'}</p>
    {(kind==='coach'||kind==='twin'||kind==='clarify')&&<ReviewBadge review={r.review}/>}
    {Array.isArray(extra.questions)&&extra.questions.length>1&&<ul className="coach-questions">{extra.questions.map((q,i)=><li key={i}>{q}</li>)}</ul>}
    {r.followUp&&<p className="lab-follow">{r.followUp}</p>}
    {kind==='debate'&&extra.debate&&<div className="lab-debate"><div className="lab-side pro"><h5><ThumbsUp size={14}/>Advocate</h5><ul>{extra.debate.for.map((p,i)=><li key={i}>{p}</li>)}</ul></div><div className="lab-side con"><h5><ThumbsDown size={14}/>Skeptic</h5><ul>{extra.debate.against.map((p,i)=><li key={i}>{p}</li>)}</ul></div><div className={'lab-verdict '+extra.debate.verdict}><Gavel size={15}/>Judge: <strong>{({go:'Go ahead',wait:'Wait or scale it down',skip:'Skip it'})[extra.debate.verdict]}</strong></div></div>}
    <ScenarioChart result={r} height={kind==='coach'||kind==='twin'?170:220}/>
    {!['coach','twin','health','advisor'].includes(kind)&&Array.isArray(r.highlights)&&r.highlights.length>0&&<div className="lab-highlights">{r.highlights.map((h,i)=><span key={i} className={'lab-chip '+(h.direction||'neutral')}><b>{h.label}</b>{h.value?` ${h.value}`:` ${h.before??''} → ${h.after??''}`}</span>)}</div>}
    {kind==='advisor'&&Array.isArray(extra.actions)&&extra.actions.length>0&&<ol className="lab-actions">{extra.actions.map((a,i)=><li key={a.simId||i}><strong>{a.title}</strong><span>{a.why}</span></li>)}</ol>}
    {(kind==='health'||kind==='advisor')&&Array.isArray(extra.vitals)&&<div className="lab-vitals">{extra.vitals.filter(v=>v.key!=='score').map(v=><div key={v.key} className={'lab-vital '+v.band}><span>{VITAL_NAMES[v.key]||v.key}</span><strong>{v.display}</strong><small>{v.band}</small></div>)}</div>}
    {kind==='ripple'&&Array.isArray(extra.chain||extra.engineChain)&&<ol className="lab-chain">{(extra.chain?.length?extra.chain:extra.engineChain).map((c,i)=><li key={i} className={c.severity}><span>{c.step}</span></li>)}</ol>}
    {kind==='opportunity'&&Array.isArray(extra.picks)&&<div className="lab-opps">{extra.picks.map(p=><div key={p.opportunity} className="lab-opp"><strong>{p.title}</strong>{p.estMonthlySavings>0&&<span className="lab-save">{usd(p.estMonthlySavings)}/mo</span>}{p.why&&<p>{p.why}</p>}<small>{p.free?'Free to do':'Costs cash now'} · {p.scope}</small></div>)}</div>}
    {kind==='life_event'&&Array.isArray(extra.assumptions)&&<table className="lab-table"><thead><tr><th>Assumption</th><th>Amount</th><th>When</th></tr></thead><tbody>{extra.assumptions.map((a,i)=><tr key={i}><td>{a.label}</td><td>{usd(a.amount)}</td><td>{a.timing}</td></tr>)}</tbody></table>}
    {kind!=='coach'&&kind!=='twin'&&kind!=='clarify'&&(r.sections||[]).filter(sec=>!(kind==='ripple'&&/chain/i.test(sec.heading))&&!(kind==='health'&&/vitals/i.test(sec.heading))&&!(kind==='advisor'&&/moves/i.test(sec.heading))&&!(kind==='life_event'&&/assumptions/i.test(sec.heading))).map(sec=><div key={sec.heading} className="lab-section"><h5><ListChecks size={14}/>{sec.heading}</h5><ul>{sec.items.map((it,i)=><li key={i}>{it}</li>)}</ul></div>)}
    {Array.isArray(r.sources)&&r.sources.length>0&&<p className="lab-sources">Sources: {r.sources.map((x,i)=><React.Fragment key={x.url}>{i>0&&' · '}<a href={x.url} target="_blank" rel="noreferrer noopener">{x.title}</a></React.Fragment>)}</p>}
    <ProposeButtons result={r}/>
    {r.source==='fallback'&&<small className="lab-meta">Rule-based answer (Nemotron was unavailable). The numbers still come from the engine.</small>}
    <AgentTrace runId={row.runId}/>
  </div>;
}

/** Suggestions from the household's own vitals, so the first question is one click away. */
function useSuggestions(){
  const s=useHousehold();
  const base=s.myHousehold?.[0]?.baselineScenarioId??s.myHousehold?.baselineScenarioId;
  const vit=(s.myVitals||[]).filter(v=>base==null||String(v.scenarioId)===String(base));
  const band=k=>vit.find(v=>v.key===k)?.band;
  const out=[];
  if(['red','yellow'].includes(band('crunch_risk')))out.push({mode:'ask',text:'How do we avoid the cash crunch coming up?'});
  if(band('goal_track')==='red')out.push({mode:'ask',text:'How do we get our goals back on track?'});
  if(['red','yellow'].includes(band('utilization')))out.push({mode:'debate',text:'Should I pay down my credit card this month?'});
  if(['red','yellow'].includes(band('runway')))out.push({mode:'stress',text:'What if our income stopped for a month?'});
  for(const d of [{mode:'ask',text:'I want to buy a Rolex'},{mode:'debate',text:'Should we buy a $35,000 car in March?'},{mode:'stress',text:'What if Sam loses his job for two months?'},{mode:'life_event',text:"We're getting married next June"}])if(out.length<4)out.push(d);
  return out.slice(0,4);
}

const topId=s=>Math.max(0,...(s.myAiInsights||[]).map(r=>Number(r.id)));
const visible=r=>r.status!=='blocked'&&r.status!=='failed';

/**
 * Keeps the newest output in view like a chat app: scrolls to a new message when it appears, then to the
 * start of the reply once it finishes (results live in the page flow, so this scrolls the page).
 */
function useFollowNewest(rows){
  const lastRef=useRef(null);
  const last=rows[rows.length-1];
  const key=last?`${String(last.id)}:${last.status}`:'';
  useEffect(()=>{if(key)lastRef.current?.scrollIntoView({behavior:'smooth',block:last.status==='thinking'?'end':'start'})},[key]);
  return lastRef;
}

/** Past answers stay out of the way until asked for. */
function History({rows,label='Past requests'}){
  const [open,setOpen]=useState(false);
  if(!rows.length)return null;
  return <div className="lab-history"><button type="button" className="coach-new" onClick={()=>setOpen(v=>!v)}><RotateCcw size={13}/>{open?'Hide history':`${label} (${rows.length})`}</button>
    {open&&<div className="lab-history-list">{rows.slice().reverse().map(row=><details key={String(row.id)}><summary>{row.question} <small>· {row.kind.replace('_',' ')}</small></summary><Reply row={row}/></details>)}</div>}</div>;
}

/** A single workflow, compact, for embedding (e.g. "An income change" in the planner). Starts fresh. */
export function NemotronTool({mode='stress',placeholder}){
  const s=useHousehold();const m=MODES.find(x=>x.key===mode);
  const [text,setText]=useState(''),[busy,setBusy]=useState(false),[since]=useState(()=>topId(s));
  const mine=(s.myAiInsights||[]).filter(r=>r.kind===mode&&visible(r)).slice().sort((a,b)=>Number(a.id)-Number(b.id));
  const fresh=mine.filter(r=>Number(r.id)>since);const latest=fresh[fresh.length-1];
  const lastRef=useFollowNewest(latest?[latest]:[]);
  async function run(e){e.preventDefault();if(!text.trim())return;setBusy(true);try{await s.act(m.op,{[m.field]:text.trim()});setText('')}catch{}finally{setBusy(false)}}
  return <div className="nemotron-lab">
    <form className="lab-form" onSubmit={run}><input value={text} onChange={e=>setText(e.target.value)} placeholder={placeholder||m.placeholder} maxLength={300} aria-label={m.label}/><button className="workspace-button" disabled={busy||!s.capabilities?.[m.op]||!text.trim()}>{busy?'Sending…':m.label}</button></form>
    {latest&&<div ref={lastRef}><div className="coach-bubble coach-user">{latest.question}</div><Reply row={latest}/></div>}
    <History rows={mine.filter(r=>r!==latest)}/>
  </div>;
}

/** Account insights: one-tap household reports, shown on the Accounts tab. Starts fresh. */
export function AccountInsights(){
  const s=useHousehold();
  const [since]=useState(()=>topId(s)),[busy,setBusy]=useState('');
  const kinds=new Set([...QUICK.map(q=>q.key),'advisor']);
  const all=(s.myAiInsights||[]).filter(r=>kinds.has(r.kind)&&visible(r)).slice().sort((a,b)=>Number(a.id)-Number(b.id));
  const fresh=all.filter(r=>Number(r.id)>since);const latest=fresh[fresh.length-1];
  const lastRef=useFollowNewest(latest?[latest]:[]);
  async function run(q){setBusy(q.key);try{await s.act(q.op,{})}catch{}finally{setBusy('')}}
  return <section className="simple-card account-insights">
    <div className="simple-section-heading"><h2>Account insights</h2><span className="simple-demo-badge">NEMOTRON</span></div>
    <p className="simple-muted">Nemotron reads every account, card, loan and bill, runs the numbers, and tells you what to do. Recommended moves are ready to send for approval in one tap.</p>
    <button className="workspace-button review-accounts" onClick={()=>run({key:'advisor',op:'request_account_review'})} disabled={!!busy||!s.capabilities?.request_account_review}><Wand2 size={16}/>{busy==='advisor'?'Reviewing your accounts…':'Review my accounts'}</button>
    <div className="studio-modes">{QUICK.map(q=><button key={q.key} onClick={()=>run(q)} disabled={!!busy||!s.capabilities?.[q.op]}><q.Icon size={15}/>{busy===q.key?'Working…':q.label}</button>)}</div>
    {latest&&<div ref={lastRef}><Reply row={latest}/></div>}
    <History rows={all.filter(r=>r!==latest)} label="Past insights"/>
  </section>;
}

/**
 * Ask Nemotron: one input, several agent workflows, one feed that starts fresh each visit. Chat replies and
 * visual results appear in order; follow-ups continue the conversation; plans can go to the family to co-sign.
 */
export default function NemotronStudio(){
  const s=useHousehold();
  const [mode,setMode]=useState('ask'),[text,setText]=useState(''),[busy,setBusy]=useState(false);
  const [since,setSince]=useState(()=>topId(s)),[mountedAt]=useState(()=>topId(s));
  const boxRef=useRef(null),inputRef=useRef(null);
  const m=MODES.find(x=>x.key===mode);
  const suggestions=useSuggestions();
  const all=(s.myAiInsights||[]).filter(r=>FEED_KINDS.has(r.kind)&&!QUICK.some(q=>q.key===r.kind)&&visible(r)).slice().sort((a,b)=>Number(a.id)-Number(b.id));
  const rows=all.filter(r=>Number(r.id)>since);
  const past=all.filter(r=>Number(r.id)<=since);
  const lastCoach=[...rows].reverse().find(r=>r.kind==='coach');
  const thread=lastCoach?threadOf(lastCoach):'';
  const lastRef=useFollowNewest(rows);
  async function send(modeKey,value){
    const mm=MODES.find(x=>x.key===modeKey);const v=(value??'').trim();if(!mm||!v)return;
    setBusy(true);
    try{await s.act(mm.op,mm.key==='ask'?{message:v,threadInsightId:thread?BigInt(thread):0n}:{[mm.field]:v});setText('')}catch{}finally{setBusy(false)}
  }
  // Ask from elsewhere in the app (e.g. "Debate it" under a plan).
  useEffect(()=>{const on=e=>{const {mode:md,text:tx}=e.detail||{};if(!md)return;setMode(md);boxRef.current?.scrollIntoView({behavior:'smooth',block:'start'});send(md,tx)};window.addEventListener('nemotron:ask',on);return()=>window.removeEventListener('nemotron:ask',on)});
  const can=!!s.capabilities?.[m.op];
  // A question handed over from another screen (e.g. Overview's "Fix the crunch").
  useEffect(()=>{if(!s.capabilities?.ask_coach)return;let q='';try{q=sessionStorage.getItem('tandem/pending-ask')||'';sessionStorage.removeItem('tandem/pending-ask')}catch{}if(!q)return;setMode('ask');setTimeout(()=>boxRef.current?.scrollIntoView({behavior:'smooth',block:'start'}),300);send('ask',q)},[s.capabilities]);
  return <div className="nemotron-studio" ref={boxRef}>
    <div className="studio-modes" role="tablist">{MODES.map(x=><button key={x.key} role="tab" aria-selected={mode===x.key} className={mode===x.key?'active':''} onClick={()=>{setMode(x.key);inputRef.current?.focus()}}><x.Icon size={15}/>{x.label}</button>)}</div>
    <div className="studio-hint-row"><p className="lab-hint">{m.hint}</p><History rows={past}/></div>
    <div className="studio-feed" aria-live="polite">
      {rows.length===0&&<div className="studio-empty"><p>Try one of these, or type your own:</p><div className="lab-examples">{suggestions.map(x=><button key={x.text} type="button" onClick={()=>{setMode(x.mode);send(x.mode,x.text)}} disabled={busy}>{x.text}</button>)}</div></div>}
      {rows.map((row,i)=><div key={String(row.id)} className="studio-turn" ref={i===rows.length-1?lastRef:undefined}><div className="coach-bubble coach-user">{row.question}</div><Reply row={row}/></div>)}
    </div>
    <form className="studio-input" onSubmit={e=>{e.preventDefault();send(mode,text)}}>
      <textarea ref={inputRef} rows={2} value={text} maxLength={300} placeholder={mode==='ask'&&thread?'Ask a follow-up…':m.placeholder} aria-label={m.label}
        onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form.requestSubmit()}}}/>
      <div className="studio-actions">
        {rows.length>0&&<button type="button" className="coach-new" onClick={()=>setSince(topId(s))}><RotateCcw size={13}/> New conversation</button>}
        <button className="workspace-button" disabled={busy||!can||!text.trim()}><Send size={15}/> {busy?'Sending…':mode==='ask'?'Send':m.label}</button>
      </div>
    </form>
    {!can&&<p className="lab-meta">This feature is waiting for its backend endpoint.</p>}
  </div>;
}
