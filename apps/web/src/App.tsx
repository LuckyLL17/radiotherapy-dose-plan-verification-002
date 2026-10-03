import { useEffect, useRef, useState, type FormEvent } from 'react';
import './styles.css';

type PlanStatus = 'draft' | 'review' | 'approved';
type QaMethod = 'independent_mu' | 'gamma' | 'image_guidance';
type QaStatus = 'pass' | 'warn' | 'fail';

interface Plan {
  id: string;
  label: string;
  beamCount: number;
  energy: string;
  algorithm: string;
  mu: number;
  createdAt: string;
  status: PlanStatus;
}

interface QaMethodConfig {
  label: string;
  scoreLabel: string;
  unit: string;
  direction: 'lower' | 'higher';
  passThreshold: number;
  warnThreshold: number;
  min: number;
  max: number;
}

interface QaRun {
  id: string;
  planId: string;
  method: QaMethod;
  status: QaStatus;
  score: number;
  detail: string;
  createdAt: string;
}

interface QaHistory {
  planId: string;
  methods: Record<QaMethod, QaMethodConfig>;
  runs: QaRun[];
}

interface ConstraintCheck {
  structureId: string;
  name: string;
  metric: string;
  value: number;
  limit: number;
  unit: string;
  pass: boolean;
  delta: number;
  doseVolume: number;
}

const METHOD_ORDER: QaMethod[] = ['independent_mu', 'gamma', 'image_guidance'];
const STATUS_TEXT: Record<QaStatus, string> = {
  pass: '通过',
  warn: '警告',
  fail: '失败',
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new Error('网络连接失败，请稍后重试');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const serverError = data && typeof data === 'object' && 'error' in data ? String(data.error) : '';
    throw new Error(serverError ? `请求被拒绝（${serverError}）` : `请求失败（HTTP ${response.status}）`);
  }
  return data as T;
}

function classifyScore(config: QaMethodConfig, score: number): QaStatus {
  if (config.direction === 'higher') {
    return score >= config.passThreshold ? 'pass' : score >= config.warnThreshold ? 'warn' : 'fail';
  }
  return score <= config.passThreshold ? 'pass' : score <= config.warnThreshold ? 'warn' : 'fail';
}

function sortQaRuns(runs: QaRun[]) {
  return [...runs].sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    if (byTime !== 0) return byTime;
    return b.id.localeCompare(a.id, undefined, { numeric: true });
  });
}

function thresholdText(config: QaMethodConfig) {
  if (config.direction === 'higher') {
    return `通过 ≥ ${config.passThreshold}${config.unit} · 警告 ≥ ${config.warnThreshold}${config.unit} 且 < ${config.passThreshold}${config.unit} · 失败 < ${config.warnThreshold}${config.unit}`;
  }
  return `通过 ≤ ${config.passThreshold}${config.unit} · 警告 > ${config.passThreshold}${config.unit} 且 ≤ ${config.warnThreshold}${config.unit} · 失败 > ${config.warnThreshold}${config.unit}`;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '未知错误';
}

export default function App() {
  const [tab, setTab] = useState('dose');
  const [patient, setPatient] = useState<any>();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [active, setActive] = useState('PLAN-A');
  const [constraints, setConstraints] = useState<{ plan: Plan; checks: ConstraintCheck[]; gate: 'ready' | 'blocked' }>();
  const [compare, setCompare] = useState<any>();
  const [slice, setSlice] = useState<{ planId: string; data: number[][] }>();
  const [reviewer, setReviewer] = useState('');

  const [qa, setQa] = useState<QaHistory | null>(null);
  const [qaLoading, setQaLoading] = useState(true);
  const [qaError, setQaError] = useState<string | null>(null);
  const [method, setMethod] = useState<QaMethod>('independent_mu');
  const [scoreInput, setScoreInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activePlanRef = useRef(active);
  const qaRequestRef = useRef(0);
  const qaAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let mounted = true;
    api('/api/patient/current').then(data => { if (mounted) setPatient(data); }).catch(() => undefined);
    api<Plan[]>('/api/plans').then(data => { if (mounted) setPlans(data); }).catch(() => undefined);
    api('/api/compare').then(data => { if (mounted) setCompare(data); }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    activePlanRef.current = active;
  }, [active]);

  useEffect(() => {
    const controller = new AbortController();
    setConstraints(undefined);
    setSlice(undefined);

    api<{ plan: Plan; checks: ConstraintCheck[]; gate: 'ready' | 'blocked' }>(
      `/api/plans/${active}/constraints`,
      { signal: controller.signal },
    ).then(data => {
      if (!controller.signal.aborted && data.plan.id === active) setConstraints(data);
    }).catch(error => {
      if ((error as Error).name !== 'AbortError') setConstraints(undefined);
    });

    api<{ planId: string; data: number[][] }>(
      `/api/plans/${active}/dose-slice?index=12`,
      { signal: controller.signal },
    ).then(data => {
      if (!controller.signal.aborted && data.planId === active) setSlice(data);
    }).catch(() => undefined);

    return () => controller.abort();
  }, [active]);

  const loadQaHistory = async (planId: string) => {
    qaAbortRef.current?.abort();
    const controller = new AbortController();
    qaAbortRef.current = controller;
    const requestId = ++qaRequestRef.current;

    setQaLoading(true);
    setQaError(null);
    let current = requestId === qaRequestRef.current && activePlanRef.current === planId;
    try {
      const data = await api<QaHistory>(`/api/plans/${planId}/independent-check`, { signal: controller.signal });
      current = requestId === qaRequestRef.current && activePlanRef.current === planId;
      if (
        !controller.signal.aborted &&
        current &&
        data.planId === planId
      ) {
        setQa(data);
      }
    } catch (error) {
      current = requestId === qaRequestRef.current && activePlanRef.current === planId;
      if ((error as Error).name !== 'AbortError' && current) {
        setQaError(errorMessage(error));
      }
    } finally {
      current = requestId === qaRequestRef.current && activePlanRef.current === planId;
      if (!controller.signal.aborted && current) {
        setQaLoading(false);
      }
    }
  };

  useEffect(() => {
    qaRequestRef.current += 1;
    qaAbortRef.current?.abort();
    setQa(null);
    setQaError(null);
    setQaLoading(true);
    setMethod('independent_mu');
    setScoreInput('');
    setFormError(null);
    setNotice(null);
    void loadQaHistory(active);
    return () => {
      qaRequestRef.current += 1;
      qaAbortRef.current?.abort();
    };
  }, [active]);

  const approve = async () => {
    const r = await fetch(`/api/plans/${active}/approve`, { method: 'POST' }).then(x => x.json());
    alert(r.approved ? '计划已签发' : `签发被阻断：${r.failed?.map((x: any) => x.name).join('、')}`);
  };

  const selectedConfig = qa?.methods[method];
  const trimmedScore = scoreInput.trim();
  const parsedScore = trimmedScore === '' ? null : Number(trimmedScore);
  const invalidScore = selectedConfig && parsedScore !== null
    ? (!Number.isFinite(parsedScore) || parsedScore < selectedConfig.min || parsedScore > selectedConfig.max)
    : false;
  const previewStatus = selectedConfig && parsedScore !== null && !invalidScore
    ? classifyScore(selectedConfig, parsedScore)
    : null;

  const changeMethod = (nextMethod: QaMethod) => {
    setMethod(nextMethod);
    setScoreInput('');
    setFormError(null);
    setNotice(null);
  };

  const submitQa = async (event: FormEvent) => {
    event.preventDefault();
    if (!qa || !selectedConfig || submitting || qaLoading) return;

    const rawScore = scoreInput.trim();
    if (!rawScore) {
      setFormError('请输入需要记录的分数。');
      return;
    }
    const score = Number(rawScore);
    if (!Number.isFinite(score) || score < selectedConfig.min || score > selectedConfig.max) {
      setFormError(`非法分数：${selectedConfig.scoreLabel}必须是 ${selectedConfig.min} 到 ${selectedConfig.max} ${selectedConfig.unit} 之间的数字。`);
      return;
    }

    const submitPlan = active;
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    try {
      const run = await api<QaRun>(`/api/plans/${submitPlan}/independent-check`, {
        method: 'POST',
        body: JSON.stringify({ method, score }),
      });
      if (run.planId !== submitPlan || activePlanRef.current !== submitPlan) return;

      setQa(previous => previous ? {
        ...previous,
        runs: sortQaRuns([run, ...previous.runs.filter(item => item.id !== run.id)]),
      } : previous);
      setNotice(`已提交并写入审计记录：${selectedConfig.label} / ${run.score}${selectedConfig.unit}，判定为${STATUS_TEXT[run.status]}。`);
      setScoreInput('');
    } catch (error) {
      if (activePlanRef.current === submitPlan) setFormError(errorMessage(error));
    } finally {
      if (activePlanRef.current === submitPlan) setSubmitting(false);
    }
  };

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">RADIATION ONCOLOGY / PLAN QA</span>
          <h1>放射治疗剂量计划验证与器官风险评估系统</h1>
          <p>{patient?.patient?.id} · {patient?.patient?.diagnosis} · 处方 {patient?.patient?.rxDose} Gy / {patient?.patient?.fractions} 次</p>
        </div>
        <div className="badge">物理师复核模式</div>
      </header>

      <nav>
        {[
          ['dose', '剂量阅片'],
          ['constraints', '约束校验'],
          ['independent', '独立验证中心'],
          ['compare', '计划对比'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      <section className="toolbar">
        <label>当前计划
          <select value={active} onChange={e => setActive(e.target.value)}>
            {plans.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <span className={`planStatus ${constraints?.gate ?? 'loading'}`}>
          {constraints?.gate === 'ready' ? '签发门禁通过' : constraints ? '存在约束风险' : '正在读取门禁'}
        </span>
      </section>

      {tab === 'dose' && (
        <section className="grid">
          <div className="panel imagePanel">
            <div className="panelHead">
              <h2>断层切片剂量叠加</h2>
              <span>切片 12 / 32 · 等剂量线：20 / 50 / 95%</span>
            </div>
            <div className="slice">
              {slice?.data.map((row: number[], y: number) => row.map((v: number, x: number) => (
                <span key={`${x}-${y}`} style={{ background: `hsl(${Math.max(0, 240 - v * 2.2)},${v > 80 ? 88 : 55}%,${25 + v * .45}%)` }} />
              )))}
            </div>
            <div className="doseLegend">
              <span style={{ background: '#244bd5' }} />低剂量
              <span style={{ background: '#f3bb35' }} />中剂量
              <span style={{ background: '#ef555b' }} />高剂量
            </div>
          </div>
          <div className="panel">
            <div className="panelHead">
              <h2>计划参数</h2>
              <span>{active}</span>
            </div>
            {plans.find(p => p.id === active) && Object.entries(plans.find(p => p.id === active)!)
              .filter(([k]) => !['id', 'status'].includes(k))
              .map(([k, v]) => <div className="kv" key={k}><span>{k}</span><b>{String(v)}</b></div>)}
            <div className="callout">剂量验证不是单一通过/失败判断，需要同时审查靶区覆盖、危及器官受量、机器跳数和算法版本。</div>
          </div>
        </section>
      )}

      {tab === 'constraints' && (
        <section className="grid">
          <div className="panel">
            <div className="panelHead">
              <h2>结构约束校验</h2>
              <span>DVH 指标自动计算</span>
            </div>
            {constraints?.checks.map((x) => (
              <div className="constraint" key={x.structureId}>
                <div>
                  <b>{x.name}</b>
                  <small>{x.metric} · 限值 {x.limit}{x.unit}</small>
                </div>
                <strong className={x.pass ? 'pass' : 'fail'}>{x.value}{x.unit}</strong>
                <span>{x.pass ? 'PASS' : 'FAIL'}</span>
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="panelHead">
              <h2>DVH 曲线摘要</h2>
              <span>体积-剂量关系</span>
            </div>
            {patient?.structures.map((s: any) => {
              const check = constraints?.checks.find((x) => x.structureId === s.id);
              return (
                <div className="bar" key={s.id}>
                  <span>{s.name}</span>
                  <div><i style={{ width: `${Math.min(100, check?.value ?? 0)}%` }} /></div>
                  <b>{check?.value ?? '—'}</b>
                </div>
              );
            })}
            <div className="review">
              <input placeholder="复核人姓名" value={reviewer} onChange={e => setReviewer(e.target.value)} />
              <button onClick={() => fetch(`/api/plans/${active}/peer-review`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ reviewer, note: '已完成剂量约束复核' }),
              })}>记录同行复核</button>
              <button onClick={approve}>签发计划</button>
            </div>
          </div>
        </section>
      )}

      {tab === 'independent' && (
        <section className="qaLayout">
          <div className="panel qaFormPanel">
            <div className="panelHead">
              <div>
                <h2>独立验证中心</h2>
                <p className="panelSubtitle">按计划提交 Independent MU、Gamma 或 Image Guidance 检查</p>
              </div>
              <button
                type="button"
                className="secondaryButton"
                disabled={qaLoading || submitting}
                onClick={() => loadQaHistory(active)}
              >
                {qaLoading ? '刷新中…' : '刷新历史'}
              </button>
            </div>

            <div className="qaPlanTag">计划：{plans.find(p => p.id === active)?.label ?? active}（{active}）</div>

            <form className="qaForm" onSubmit={submitQa}>
              <fieldset>
                <legend>选择验证项目</legend>
                <div className="methodButtons">
                  {METHOD_ORDER.map(item => {
                    const config = qa?.methods[item];
                    return (
                      <button
                        key={item}
                        type="button"
                        className={method === item ? 'methodButton active' : 'methodButton'}
                        disabled={submitting || qaLoading || !config}
                        onClick={() => changeMethod(item)}
                      >
                        {config?.label ?? item}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {selectedConfig && (
                <div className="thresholdCard">
                  <div className="thresholdHeader">
                    <span>{selectedConfig.scoreLabel}</span>
                    {previewStatus && <strong className={`qaStatus ${previewStatus}`}>{STATUS_TEXT[previewStatus]}</strong>}
                    {invalidScore && <strong className="qaStatus invalid">非法分数</strong>}
                    {parsedScore === null && <strong className="qaStatus pending">待提交</strong>}
                  </div>
                  <p>{thresholdText(selectedConfig)}</p>
                  <small>合法范围：{selectedConfig.min} 到 {selectedConfig.max} {selectedConfig.unit}；阈值临界值按现有接口规则判定。</small>
                </div>
              )}

              <label className="scoreField">
                <span>分数 / 测量值{selectedConfig ? `（${selectedConfig.unit}）` : ''}</span>
                <input
                  value={scoreInput}
                  inputMode="decimal"
                  placeholder={selectedConfig ? `输入 ${selectedConfig.min}-${selectedConfig.max} 的数字` : '正在载入验证配置'}
                  disabled={!selectedConfig || submitting || qaLoading}
                  onChange={e => {
                    setScoreInput(e.target.value);
                    setFormError(null);
                  }}
                />
              </label>

              {formError && <div className="qaBanner error">{formError}</div>}
              {notice && <div className="qaBanner success">{notice}</div>}
              {qaError && <div className="qaBanner warning">历史记录刷新失败：{qaError}。当前仍显示上次成功获取的记录，未与其他计划混用。</div>}

              <button className="submitQa" type="submit" disabled={!selectedConfig || qaLoading || submitting}>
                {submitting ? '提交中…' : '提交独立验证'}
              </button>
              <p className="auditHint">每次成功提交都会由后端写入审计记录（independent_check）。</p>
            </form>
          </div>

          <div className="panel qaHistoryPanel">
            <div className="panelHead">
              <h2>该计划验证历史</h2>
              <span>{qaLoading ? '载入中' : `${qa?.runs.length ?? 0} 条 · 最新在前`}</span>
            </div>

            {qaLoading && <div className="qaEmpty">正在读取 {active} 的历史记录…</div>}
            {!qaLoading && qaError && !qa && <div className="qaEmpty">无法获取历史记录，请检查网络后重试。</div>}
            {!qaLoading && qa && qa.runs.length === 0 && <div className="qaEmpty">当前计划暂无独立验证记录。</div>}

            <div className="qaHistoryList">
              {qa?.runs.map(run => {
                const runConfig = qa.methods[run.method];
                return (
                  <article className="qaHistoryItem" key={run.id}>
                    <div className="qaHistoryTop">
                      <div>
                        <strong>{runConfig.label}</strong>
                        <span>{run.id}</span>
                      </div>
                      <span className={`qaStatus ${run.status}`}>{STATUS_TEXT[run.status]}</span>
                    </div>
                    <div className="qaScoreLine">
                      <b>{run.score}<small>{runConfig.unit}</small></b>
                      <span>{thresholdText(runConfig)}</span>
                    </div>
                    <p>{run.detail}</p>
                    <time>{formatTime(run.createdAt)}</time>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {tab === 'compare' && (
        <section className="panel">
          <div className="panelHead">
            <h2>计划对比与选择</h2>
            <span>同一患者、不同照射技术</span>
          </div>
          <div className="compareGrid">
            {compare?.plans.map((p: any) => (
              <div key={p.id} className={`compareCard ${p.id === active ? 'selected' : ''}`} onClick={() => setActive(p.id)}>
                <h3>{p.label}</h3>
                <strong>{p.targetCoverage}%</strong>
                <small>PTV D95 覆盖</small>
                <p>MU {p.mu} · 约束失败 {p.checks.filter((x: any) => !x.pass).length} 项</p>
                {p.checks.map((x: any) => (
                  <div key={x.structureId} className={x.pass ? 'tinyPass' : 'tinyFail'}>{x.name}: {x.value}{x.unit}</div>
                ))}
              </div>
            ))}
          </div>
          <div className="recommend">系统建议：{compare?.recommendation}</div>
        </section>
      )}
    </main>
  );
}
