import {useCallback,useEffect,useRef,useState} from 'react';

type Status='pass'|'warn'|'fail';
type Method='independent_mu'|'gamma'|'image_guidance';
type Threshold={label:string;short:string;unit:string;direction:'high'|'low';passAt:number;warnAt:number};
type Run={id:string;planId:string;method:Method;status:Status;score:number;detail:string;createdAt:string;note?:string};

const FALLBACK:Record<Method,Threshold>={
  independent_mu:{label:'独立 MU 复算',short:'Independent MU',unit:'%',direction:'low',passAt:3,warnAt:5},
  gamma:{label:'Gamma 通过率',short:'3%/3mm Gamma',unit:'%',direction:'high',passAt:95,warnAt:90},
  image_guidance:{label:'影像引导配准',short:'Image Guidance',unit:'mm',direction:'low',passAt:3,warnAt:5}
};
const STATUS_TEXT:Record<Status,string>={pass:'通过',warn:'警告',fail:'失败'};

function classify(t:Threshold,score:number):Status{
  return t.direction==='high'
    ?(score>=t.passAt?'pass':score>=t.warnAt?'warn':'fail')
    :(score<=t.passAt?'pass':score<=t.warnAt?'warn':'fail');
}

function thresholdText(t:Threshold){
  return t.direction==='high'
    ?`通过 ≥ ${t.passAt}${t.unit}，警告 ${t.warnAt}–${t.passAt}${t.unit}，失败 < ${t.warnAt}${t.unit}`
    :`通过 ≤ ${t.passAt}${t.unit}，警告 ${t.passAt}–${t.warnAt}${t.unit}，失败 > ${t.warnAt}${t.unit}`;
}

function fmtTime(iso:string){
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return iso;
  const p=(n:number)=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function VerificationCenter({planId}:{planId:string}){
  const [thresholds,setThresholds]=useState<Record<Method,Threshold>|null>(null);
  const [runs,setRuns]=useState<Run[]|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [method,setMethod]=useState<Method>('independent_mu');
  const [scoreText,setScoreText]=useState('');
  const [note,setNote]=useState('');
  const [submitting,setSubmitting]=useState(false);
  const [flash,setFlash]=useState<{ok:boolean;text:string}|null>(null);
  const seqRef=useRef(0);
  const submitSeqRef=useRef(0);

  const load=useCallback(async (isMounted:{v:boolean})=>{
    const seq=++seqRef.current;
    setLoading(true);
    setError(null);
    try{
      const res=await fetch(`/api/plans/${planId}/independent-check`);
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      if(!isMounted.v||seq!==seqRef.current)return;
      if(!data||!data.thresholds||!Array.isArray(data.runs))throw new Error('bad_payload');
      setThresholds(data.thresholds as Record<Method,Threshold>);
      setRuns((data.runs as Run[]).slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)));
      setError(null);
    }catch(e){
      if(!isMounted.v||seq!==seqRef.current)return;
      setThresholds(null);
      setRuns(null);
      setError(e instanceof Error&&e.message==='HTTP 404'?'计划不存在，无法加载验证历史。':'网络失败或服务不可用，请重试。');
    }finally{
      if(isMounted.v&&seq===seqRef.current)setLoading(false);
    }
  },[planId]);

  useEffect(()=>{
    setRuns(null);
    setThresholds(null);
    setError(null);
    setFlash(null);
    setScoreText('');
    const alive={v:true};
    load(alive);
    return ()=>{alive.v=false};
  },[load]);

  const t:Threshold=thresholds?.[method]??FALLBACK[method];
  const scoreRaw=Number(scoreText);
  const scoreValid=scoreText.trim()!==''&&Number.isFinite(scoreRaw)&&scoreRaw>=0&&(method!=='gamma'||scoreRaw<=100);
  const preview:Status|'invalid'=scoreValid?classify(t,scoreRaw):'invalid';

  const submit=async ()=>{
    if(!scoreValid||submitting)return;
    const seq=++submitSeqRef.current;
    setSubmitting(true);
    setFlash(null);
    try{
      const res=await fetch(`/api/plans/${planId}/independent-check`,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({method,score:scoreRaw,note:note.trim()||undefined})
      });
      if(seq!==submitSeqRef.current)return;
      const data=await res.json().catch(()=>null);
      if(!res.ok){
        if(data?.error==='invalid_score')setFlash({ok:false,text:`非法分数：服务器拒绝了 ${scoreRaw}，未记录任何结果。`});
        else if(data?.error==='invalid_method')setFlash({ok:false,text:'非法检查类型，提交已拒绝。'});
        else if(res.status===404)setFlash({ok:false,text:'计划不存在，提交失败。'});
        else setFlash({ok:false,text:'网络失败：提交未确认，请勿假设已通过，可重试。'});
        return;
      }
      const run=data as Run;
      setRuns(prev=>[run,...(prev??[]).filter(x=>x.id!==run.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)));
      setScoreText('');
      setNote('');
      setFlash({ok:true,text:`已提交：${t.label} ${run.score}${t.unit} → ${STATUS_TEXT[run.status]}`});
    }catch{
      if(seq!==submitSeqRef.current)return;
      setFlash({ok:false,text:'网络失败：提交未确认，未改变本地历史，请重试。'});
    }finally{
      if(seq===submitSeqRef.current)setSubmitting(false);
    }
  };

  return (
    <section className="grid verifyGrid">
      <div className="panel">
        <div className="panelHead"><h2>独立验证中心 · 提交检查</h2><span>{planId}</span></div>
        <p className="verifyIntro">物理师按计划选择独立 MU、gamma 或影像引导检查，录入分数后由系统按既有阈值判定；每次提交都会写入审计记录。</p>
        <div className="methodCards">
          {(Object.keys(FALLBACK)as Method[]).map(m=>{
            const mt=thresholds?.[m]??FALLBACK[m];
            return (
              <button key={m} className={`methodCard ${method===m?'selected':''}`} onClick={()=>setMethod(m)} type="button">
                <b>{mt.label}</b>
                <small>{mt.short}</small>
              </button>
            );
          })}
        </div>
        <div className="verifyThreshold">
          <span className="verifyThresholdLabel">判定阈值</span>
          <span>{thresholdText(t)}</span>
          <i className={`dot dot-${classify(t,t.passAt)}`} title="临界值按通过处理"/>
        </div>
        <label className="verifyField">分数 / 测量值（{t.unit}）
          <input
            inputMode="decimal"
            placeholder={method==='gamma'?'例如 95.2（0–100）':'例如 2.4（≥ 0）'}
            value={scoreText}
            onChange={e=>setScoreText(e.target.value)}
          />
        </label>
        <label className="verifyField">说明（可选）
          <input placeholder="复算条件、设备或备注" value={note} onChange={e=>setNote(e.target.value)}/>
        </label>
        <div className="verifyActions">
          <div className={`statusBadge ${preview==='invalid'?'invalid':`badge-${preview}`}`}>
            {scoreText.trim()===''?'待录入':scoreValid?STATUS_TEXT[preview as Status]:'非法分数'}
          </div>
          <button onClick={submit} disabled={!scoreValid||submitting}>{submitting?'提交中…':'提交验证'}</button>
        </div>
        {flash&&<div className={`verifyFlash ${flash.ok?'flashOk':'flashErr'}`}>{flash.text}</div>}
      </div>

      <div className="panel">
        <div className="panelHead">
          <h2>该计划的验证历史</h2>
          <button className="refreshBtn" onClick={()=>load({v:true})} disabled={loading} type="button">{loading?'刷新中…':'刷新'}</button>
        </div>
        {loading&&<div className="verifyHint">正在加载 {planId} 的历史记录…</div>}
        {!loading&&error&&(
          <div className="verifyError">
            <b>加载失败</b>
            <p>{error}</p>
            <p className="verifyWarn">为避免混淆，已隐藏其它计划或过期的结果。</p>
            <button onClick={()=>load({v:true})} type="button">重试</button>
          </div>
        )}
        {!loading&&!error&&runs&&runs.length===0&&<div className="verifyHint">该计划尚无独立验证记录，请在左侧提交第一次检查。</div>}
        {!loading&&!error&&runs&&runs.length>0&&(
          <div className="historyList">
            {runs.map(r=>{
              const rt=thresholds?.[r.method]??FALLBACK[r.method];
              return (
                <div key={r.id} className="historyItem">
                  <i className={`dot dot-${r.status}`}/>
                  <div className="historyMain">
                    <b>{rt.label}</b>
                    <small>{r.detail}</small>
                    {r.note&&<small className="historyNote">说明：{r.note}</small>}
                    <small className="historyTime">{fmtTime(r.createdAt)} · {r.id}</small>
                  </div>
                  <div className="historySide">
                    <strong>{r.score}{rt.unit}</strong>
                    <span className={`statusBadge badge-${r.status}`}>{STATUS_TEXT[r.status]}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!loading&&!error&&thresholds&&(
          <div className="callout">阈值来源：服务端判定规则。临界值（{t.passAt}{t.unit} / {t.warnAt}{t.unit}）按“通过/警告”边界处理，历史按提交时间倒序排列。</div>
        )}
      </div>
    </section>
  );
}
