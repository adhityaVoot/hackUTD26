import React,{useState} from 'react';
import {ResponsiveContainer,LineChart,Line,XAxis,YAxis,Tooltip,CartesianGrid,Legend,ReferenceLine} from 'recharts';
import {ShieldAlert,Waves,HeartPulse,PiggyBank,CalendarClock,Sparkles,CheckCircle2,Search,Calculator,PenLine,ShieldCheck,Route,Bot,Wand2,ListChecks,Scale,ThumbsUp,ThumbsDown,Gavel} from 'lucide-react';
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

const TOOLS=[
  {key:'debate',label:'Debate it',Icon:Scale,op:'debate_decision',field:'decision',hint:'An Advocate and a Skeptic argue your decision from the simulation; a Judge decides.',placeholder:'Should we buy a $35,000 car in March?',examples:['Should we buy a $35,000 car in March?','Should we take a $3,200 trip in June?']},
  {key:'stress',label:'Stress test',Icon:ShieldAlert,op:'stress_test',field:'scenario',hint:'Survive an emergency: three severities, the weakest point, and a fix.',placeholder:'What if Sam loses his job for two months?',examples:['Job loss for 3 months','$4,000 medical bill','Rent goes up $300']},
  {key:'ripple',label:'Ripple effect',Icon:Waves,op:'simulate_ripple',field:'decision',hint:'One decision, every knock-on effect, in order.',placeholder:'Buy a $1,500 laptop next week',examples:['A $1,500 laptop next week','A $35,000 car in March']},
  {key:'life_event',label:'Life event',Icon:CalendarClock,op:'simulate_life_event',field:'event',hint:'Turns a life change into dated costs, a savings target and a checklist.',placeholder:"We're getting married next June",examples:["We're getting married next June",'Having a baby in the spring']},
  {key:'health',label:'Health check',Icon:HeartPulse,op:'request_health_check',hint:'All six vitals explained, plus the single best move.'},
  {key:'opportunity',label:'Find savings',Icon:PiggyBank,op:'scan_opportunities',hint:'Subscriptions that crept up, interest you can avoid, idle cash.'},
  {key:'briefing',label:"What's coming up",Icon:Sparkles,op:'request_briefing',hint:'The next 60 days: cash, bills, goals, and anything to act on.'},
];

function Result({tool,row}){
  const r=parse(row);
  if(row.status==='thinking')return <div className="lab-result thinking"><p><Wand2 size={15}/> Nemotron agents are working on this…</p><AgentTrace runId={row.runId} live/></div>;
  const extra=r.extra||{};
  return <div className="lab-result">
    <div className="lab-result-head"><h4>{r.title||tool.label}</h4><ReviewBadge review={r.review}/></div>
    <p className="lab-answer">{r.answer}</p>
    {r.followUp&&<p className="lab-follow">{r.followUp}</p>}
    <ScenarioChart result={r}/>
    {Array.isArray(r.highlights)&&r.highlights.length>0&&<div className="lab-highlights">{r.highlights.map((h,i)=><span key={i} className={'lab-chip '+(h.direction||'neutral')}><b>{h.label}</b>{h.value?` ${h.value}`:` ${h.before??''} → ${h.after??''}`}</span>)}</div>}
    {tool.key==='debate'&&extra.debate&&<div className="lab-debate"><div className="lab-side pro"><h5><ThumbsUp size={14}/>Advocate</h5><ul>{extra.debate.for.map((p,i)=><li key={i}>{p}</li>)}</ul></div><div className="lab-side con"><h5><ThumbsDown size={14}/>Skeptic</h5><ul>{extra.debate.against.map((p,i)=><li key={i}>{p}</li>)}</ul></div><div className={'lab-verdict '+extra.debate.verdict}><Gavel size={15}/>Judge: <strong>{({go:'Go ahead',wait:'Wait or scale it down',skip:'Skip it'})[extra.debate.verdict]}</strong></div></div>}
    {tool.key==='health'&&Array.isArray(extra.vitals)&&<div className="lab-vitals">{extra.vitals.filter(v=>v.key!=='score').map(v=><div key={v.key} className={'lab-vital '+v.band}><span>{({runway:'Cash runway',crunch_risk:'Overdraft risk',dti:'Debt-to-income',utilization:'Card utilization',savings_rate:'Savings rate',goal_track:'Goal track'})[v.key]||v.key}</span><strong>{v.display}</strong><small>{v.band}</small></div>)}</div>}
    {tool.key==='ripple'&&Array.isArray(extra.chain||extra.engineChain)&&<ol className="lab-chain">{(extra.chain?.length?extra.chain:extra.engineChain).map((c,i)=><li key={i} className={c.severity}><span>{c.step}</span></li>)}</ol>}
    {tool.key==='opportunity'&&Array.isArray(extra.picks)&&<div className="lab-opps">{extra.picks.map(p=><div key={p.opportunity} className="lab-opp"><strong>{p.title}</strong>{p.estMonthlySavings>0&&<span className="lab-save">{usd(p.estMonthlySavings)}/mo</span>}{p.why&&<p>{p.why}</p>}<small>{p.free?'Free to do':'Costs cash now'} · {p.scope}</small></div>)}</div>}
    {tool.key==='life_event'&&Array.isArray(extra.assumptions)&&<table className="lab-table"><thead><tr><th>Assumption</th><th>Amount</th><th>When</th></tr></thead><tbody>{extra.assumptions.map((a,i)=><tr key={i}><td>{a.label}</td><td>{usd(a.amount)}</td><td>{a.timing}</td></tr>)}</tbody></table>}
    {(r.sections||[]).filter(sec=>!(tool.key==='ripple'&&/chain/i.test(sec.heading))&&!(tool.key==='health'&&/vitals/i.test(sec.heading))).map(sec=><div key={sec.heading} className="lab-section"><h5><ListChecks size={14}/>{sec.heading}</h5><ul>{sec.items.map((it,i)=><li key={i}>{it}</li>)}</ul></div>)}
    {Array.isArray(r.sources)&&r.sources.length>0&&<p className="lab-sources">Sources: {r.sources.map((x,i)=><React.Fragment key={x.url}>{i>0&&' · '}<a href={x.url} target="_blank" rel="noreferrer noopener">{x.title}</a></React.Fragment>)}</p>}
    {r.source==='fallback'&&<small className="lab-meta">Rule-based answer (Nemotron was unavailable). The numbers still come from the engine.</small>}
    <AgentTrace runId={row.runId}/>
  </div>;
}

/** Nemotron what-if lab: features that are easier to see than to read, each with its own button. */
export default function NemotronLab(){
  const s=useHousehold();
  const [active,setActive]=useState('debate'),[text,setText]=useState({}),[busy,setBusy]=useState(false);
  const tool=TOOLS.find(t=>t.key===active);
  const latest=(s.myAiInsights||[]).filter(r=>r.kind===active&&r.status!=='blocked'&&r.status!=='failed').slice().sort((a,b)=>Number(b.id)-Number(a.id))[0];
  const can=!!s.capabilities?.[tool.op];
  async function run(value){
    const params=tool.field?{[tool.field]:(value??text[active]??'').trim()}:{};
    if(tool.field&&!params[tool.field])return;
    setBusy(true);try{await s.act(tool.op,params)}catch{}finally{setBusy(false)}
  }
  return <div className="nemotron-lab">
    <div className="lab-tools" role="tablist">{TOOLS.map(t=><button key={t.key} role="tab" aria-selected={active===t.key} className={active===t.key?'active':''} onClick={()=>setActive(t.key)}><t.Icon size={16}/>{t.label}</button>)}</div>
    <p className="lab-hint">{tool.hint}</p>
    {tool.field?<form className="lab-form" onSubmit={e=>{e.preventDefault();run()}}>
      <input value={text[active]||''} onChange={e=>setText(v=>({...v,[active]:e.target.value}))} placeholder={tool.placeholder} maxLength={300} aria-label={tool.label}/>
      <button className="workspace-button" disabled={busy||!can}>{busy?'Sending…':'Run'}</button>
      {tool.examples&&<div className="lab-examples">{tool.examples.map(x=><button type="button" key={x} onClick={()=>{setText(v=>({...v,[active]:x}));run(x)}} disabled={busy||!can}>{x}</button>)}</div>}
    </form>:<button className="workspace-button lab-run" onClick={()=>run()} disabled={busy||!can}>{busy?'Sending…':`Run ${tool.label.toLowerCase()}`}</button>}
    {!can&&<p className="lab-meta">This feature is waiting for its backend endpoint.</p>}
    {latest?<Result tool={tool} row={latest}/>:<p className="lab-empty">Nothing yet. Run it to see your household's numbers.</p>}
  </div>;
}
