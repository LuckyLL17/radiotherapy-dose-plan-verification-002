import Fastify from 'fastify';
import cors from '@fastify/cors';

type Structure = {
  id: string;
  name: string;
  type: 'target' | 'organ';
  volume: number;
  priority: 'high' | 'medium' | 'low';
  constraint: { metric: 'D95' | 'Dmax' | 'V20'; limit: number; unit: string };
};

type Plan = {
  id: string;
  label: string;
  beamCount: number;
  energy: string;
  algorithm: string;
  mu: number;
  createdAt: string;
  status: 'draft' | 'review' | 'approved';
};

type QaMethod = 'independent_mu' | 'gamma' | 'image_guidance';
type QaStatus = 'pass' | 'warn' | 'fail';

type QaRun = {
  id: string;
  planId: string;
  method: QaMethod;
  status: QaStatus;
  score: number;
  detail: string;
  createdAt: string;
};

type QaMethodConfig = {
  label: string;
  scoreLabel: string;
  unit: string;
  direction: 'lower' | 'higher';
  passThreshold: number;
  warnThreshold: number;
  min: number;
  max: number;
};

const patient = {
  id: 'PT-2026-0917',
  name: '示例患者',
  diagnosis: '肺部肿瘤（演示数据）',
  site: '右肺下叶',
  fractions: 30,
  rxDose: 60,
};

const structures: Structure[] = [
  { id: 'PTV', name: 'PTV-60', type: 'target', volume: 84, priority: 'high', constraint: { metric: 'D95', limit: 95, unit: '%' } },
  { id: 'LUNG', name: '双肺-PTV', type: 'organ', volume: 4200, priority: 'high', constraint: { metric: 'V20', limit: 25, unit: '%' } },
  { id: 'HEART', name: '心脏', type: 'organ', volume: 720, priority: 'high', constraint: { metric: 'V20', limit: 15, unit: '%' } },
  { id: 'CORD', name: '脊髓', type: 'organ', volume: 58, priority: 'high', constraint: { metric: 'Dmax', limit: 45, unit: 'Gy' } },
  { id: 'ESOPH', name: '食管', type: 'organ', volume: 88, priority: 'medium', constraint: { metric: 'Dmax', limit: 50, unit: 'Gy' } },
];

const plans: Plan[] = [
  { id: 'PLAN-A', label: 'VMAT 主计划', beamCount: 2, energy: '6MV FFF', algorithm: 'Acuros XB 18.0', mu: 634, createdAt: '2026-09-30T08:20:00Z', status: 'review' },
  { id: 'PLAN-B', label: 'IMRT 对照计划', beamCount: 7, energy: '6MV', algorithm: 'AAA 16.1', mu: 712, createdAt: '2026-09-29T16:40:00Z', status: 'draft' },
];

const audits: Array<Record<string, unknown>> = [];

const QA_METHODS: Record<QaMethod, QaMethodConfig> = {
  independent_mu: {
    label: 'Independent MU',
    scoreLabel: '独立 MU 复算差异',
    unit: '%',
    direction: 'lower',
    passThreshold: 3,
    warnThreshold: 5,
    min: 0,
    max: 100,
  },
  gamma: {
    label: 'Gamma 3%/3mm',
    scoreLabel: 'Gamma 通过率',
    unit: '%',
    direction: 'higher',
    passThreshold: 95,
    warnThreshold: 90,
    min: 0,
    max: 100,
  },
  image_guidance: {
    label: 'Image Guidance',
    scoreLabel: '影像引导配准偏差',
    unit: 'mm',
    direction: 'lower',
    passThreshold: 3,
    warnThreshold: 5,
    min: 0,
    max: 100,
  },
};

const qaRuns: QaRun[] = [
  {
    id: 'QA-071',
    planId: 'PLAN-A',
    method: 'independent_mu',
    status: 'pass',
    score: 1.7,
    detail: '独立 MU 复算差异 1.7%，未超过通过阈值 3%',
    createdAt: '2026-09-30T09:16:00Z',
  },
  {
    id: 'QA-072',
    planId: 'PLAN-A',
    method: 'gamma',
    status: 'pass',
    score: 98.4,
    detail: '3%/3mm γ 通过率 98.4%，未低于通过阈值 95%',
    createdAt: '2026-09-30T09:23:00Z',
  },
];

let qaSequence = qaRuns.reduce((max, run) => Math.max(max, Number(run.id.split('-')[1])), 70);
const peerChecklist = new Map<string, Array<{ item: string; checked: boolean; reviewer: string; at: string }>>();
const deliveries = new Map<string, Array<{ fraction: number; deliveredGy: number; setupShift: { x: number; y: number; z: number }; at: string }>>();
const deviations: Array<{ id: string; planId: string; severity: 'low' | 'medium' | 'high'; category: string; detail: string; state: 'open' | 'resolved'; createdAt: string }> = [];

function metrics(plan: Plan) {
  const bias = plan.id === 'PLAN-A' ? 0 : 3;
  return structures.map(s => {
    const value = s.type === 'target'
      ? 96.4 - bias
      : s.id === 'LUNG'
        ? 21.3 + bias
        : s.id === 'HEART'
          ? 10.2 + bias * .7
          : s.id === 'CORD'
            ? 42.1 + bias * 1.1
            : 46.8 + bias;
    return {
      structureId: s.id,
      name: s.name,
      metric: s.constraint.metric,
      value: +value.toFixed(2),
      limit: s.constraint.limit,
      unit: s.constraint.unit,
      pass: value <= s.constraint.limit || s.type === 'target',
      delta: +(value - s.constraint.limit).toFixed(2),
      doseVolume: s.volume,
    };
  });
}

function dvh(plan: Plan) {
  return structures.map(s => ({
    structureId: s.id,
    name: s.name,
    points: Array.from({ length: 11 }, (_, i) => ({
      dose: +(i * plan.mu / 110).toFixed(1),
      volume: +(100 - i * (s.type === 'target' ? 8.3 : 10.6)).toFixed(1),
    })),
  }));
}

function slice(index: number) {
  return Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => {
    const lung = Math.pow(x - 11, 2) + Math.pow(y - 16, 2) < 105 || Math.pow(x - 23, 2) + Math.pow(y - 15, 2) < 90;
    const tumor = Math.pow(x - 22, 2) + Math.pow(y - 18, 2) < 12;
    const dose = tumor ? 95 : lung ? 48 + Math.max(0, 25 - Math.abs(x - 18)) * 1.4 : 10;
    return Math.round(dose + Math.sin((x + index) * .7) * 3);
  }));
}

function isQaMethod(value: string): value is QaMethod {
  return value === 'independent_mu' || value === 'gamma' || value === 'image_guidance';
}

function classifyQaScore(method: QaMethod, score: number): QaStatus {
  const config = QA_METHODS[method];
  if (config.direction === 'higher') {
    return score >= config.passThreshold ? 'pass' : score >= config.warnThreshold ? 'warn' : 'fail';
  }
  return score <= config.passThreshold ? 'pass' : score <= config.warnThreshold ? 'warn' : 'fail';
}

function formatScore(score: number) {
  return String(Number(score.toFixed(2)));
}

function buildQaDetail(method: QaMethod, score: number, status: QaStatus) {
  const config = QA_METHODS[method];
  const scoreText = `${formatScore(score)}${config.unit}`;
  const passText = `${formatScore(config.passThreshold)}${config.unit}`;
  const warnText = `${formatScore(config.warnThreshold)}${config.unit}`;

  if (method === 'gamma') {
    if (status === 'pass') return `3%/3mm γ 通过率 ${scoreText}，未低于通过阈值 ${passText}`;
    if (status === 'warn') return `3%/3mm γ 通过率 ${scoreText}，低于通过阈值 ${passText} 但未低于警告阈值 ${warnText}`;
    return `3%/3mm γ 通过率 ${scoreText}，低于警告阈值 ${warnText}`;
  }

  const subject = method === 'independent_mu' ? '独立 MU 复算差异' : '影像引导配准偏差';
  if (status === 'pass') return `${subject} ${scoreText}，未超过通过阈值 ${passText}`;
  if (status === 'warn') return `${subject} ${scoreText}，超过通过阈值 ${passText} 但未超过警告阈值 ${warnText}`;
  return `${subject} ${scoreText}，超过警告阈值 ${warnText}`;
}

function qaRunSequence(run: QaRun) {
  return Number(run.id.split('-')[1]) || 0;
}

function sortQaRuns(runs: QaRun[]) {
  return [...runs].sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime !== 0 ? byTime : qaRunSequence(b) - qaRunSequence(a);
  });
}

function releaseDossier(planId: string) {
  const plan = plans.find(p => p.id === planId);
  if (!plan) return { error: 'plan_not_found' as const };
  const checks = metrics(plan);
  const qa = sortQaRuns(qaRuns.filter(x => x.planId === planId));
  const checklist = peerChecklist.get(planId) ?? [];
  const required = ['靶区轮廓与处方一致性', '危及器官约束复核', '束角与碰撞检查', '独立剂量验证'];
  const unchecked = required.filter(item => !checklist.some(x => x.item === item && x.checked));
  const delivery = deliveries.get(planId) ?? [];
  const blockers = [
    ...checks.filter(x => !x.pass).map(x => `${x.name} 约束失败`),
    ...qa.filter(x => x.status === 'fail').map(x => `${QA_METHODS[x.method].label} QA 失败`),
    ...unchecked.map(x => `同行复核缺失：${x}`),
    ...deviations.filter(x => x.planId === planId && x.severity === 'high' && x.state === 'open').map(x => `未关闭偏差：${x.category}`),
  ];
  return {
    plan,
    checks,
    qa,
    checklist,
    deliverySummary: {
      fractions: delivery.length,
      cumulativeDose: +delivery.reduce((s, x) => s + x.deliveredGy, 0).toFixed(2),
      prescriptionDose: patient.rxDose,
    },
    gate: blockers.length ? 'blocked' : 'ready',
    blockers,
    ntcp: {
      lungPneumonitis: +Math.max(1, Math.min(35, metrics(plan).find(x => x.structureId === 'LUNG')!.value * 1.08)).toFixed(1),
      heartEvent: +Math.max(.2, Math.min(20, metrics(plan).find(x => x.structureId === 'HEART')!.value * .46)).toFixed(1),
    },
  };
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ status: 'ok', service: 'radiotherapy-dose-plan-verification' }));
app.get('/api/patient/current', async () => ({ patient, structures }));
app.get('/api/plans', async () => plans);
app.get('/api/plans/:id/dose-slice', async req => {
  const id = (req.params as { id: string }).id;
  if (!plans.some(p => p.id === id)) return { error: 'plan_not_found' };
  const q = req.query as { index?: string };
  const index = Number(q.index ?? 12);
  return { planId: id, index, size: 32, data: slice(index) };
});
app.get('/api/plans/:id/dvh', async req => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  return p ? dvh(p) : { error: 'plan_not_found' };
});
app.get('/api/plans/:id/constraints', async req => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  return p ? { plan: p, checks: metrics(p), gate: metrics(p).every(x => x.pass) ? 'ready' : 'blocked' } : { error: 'plan_not_found' };
});
app.get('/api/compare', async () => ({
  plans: plans.map(p => ({ id: p.id, label: p.label, checks: metrics(p), targetCoverage: metrics(p)[0].value, mu: p.mu })),
  recommendation: 'PLAN-A 在靶区覆盖和危及器官约束之间取得更优平衡',
}));
app.post('/api/plans/:id/approve', async req => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  if (!p) return { error: 'plan_not_found' };
  const checks = metrics(p);
  if (!checks.every(x => x.pass)) return { approved: false, gate: 'blocked', failed: checks.filter(x => !x.pass) };
  p.status = 'approved';
  audits.unshift({ at: new Date().toISOString(), action: 'plan_approved', planId: p.id });
  return { approved: true, plan: p };
});
app.post('/api/plans/:id/peer-review', async req => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  if (!p) return { error: 'plan_not_found' };
  const body = req.body as { reviewer: string; note: string };
  audits.unshift({ at: new Date().toISOString(), action: 'peer_review', planId: p.id, ...body });
  return { ok: true, planId: p.id, reviewer: body.reviewer };
});
app.get('/api/audit', async () => audits);

app.get('/api/plans/:id/verification-dossier', async req => releaseDossier((req.params as { id: string }).id));

app.get('/api/plans/:id/independent-check', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some(plan => plan.id === id)) {
    return reply.code(404).send({ error: 'plan_not_found' });
  }
  return {
    planId: id,
    methods: QA_METHODS,
    runs: sortQaRuns(qaRuns.filter(run => run.planId === id)),
  };
});

app.post('/api/plans/:id/independent-check', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some(plan => plan.id === id)) {
    return reply.code(404).send({ error: 'plan_not_found' });
  }

  const body = (req.body ?? {}) as { method?: string; score?: number | null };
  const method = body.method ?? 'independent_mu';
  if (!isQaMethod(method)) {
    return reply.code(400).send({ error: 'invalid_method', allowedMethods: Object.keys(QA_METHODS) });
  }

  const config = QA_METHODS[method];
  const score = body.score ?? (method === 'gamma' ? 97.1 : 2.2);
  if (typeof score !== 'number' || !Number.isFinite(score) || score < config.min || score > config.max) {
    return reply.code(400).send({
      error: 'invalid_score',
      method,
      score,
      validRange: { min: config.min, max: config.max },
    });
  }

  const status = classifyQaScore(method, score);
  qaSequence += 1;
  const run: QaRun = {
    id: `QA-${String(qaSequence).padStart(3, '0')}`,
    planId: id,
    method,
    status,
    score,
    detail: buildQaDetail(method, score, status),
    createdAt: new Date().toISOString(),
  };
  qaRuns.unshift(run);
  audits.unshift({ at: run.createdAt, action: 'independent_check', ...run });
  return run;
});

app.post('/api/plans/:id/peer-checklist', async req => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { item: string; checked: boolean; reviewer: string };
  const list = peerChecklist.get(id) ?? [];
  const existing = list.find(x => x.item === body.item);
  if (existing) {
    existing.checked = body.checked;
    existing.reviewer = body.reviewer;
    existing.at = new Date().toISOString();
  } else {
    list.push({ ...body, at: new Date().toISOString() });
  }
  peerChecklist.set(id, list);
  audits.unshift({ at: new Date().toISOString(), action: 'peer_checklist', planId: id, ...body });
  return { planId: id, items: list };
});
app.post('/api/plans/:id/adaptive-evaluation', async req => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { weightChange?: number; tumorShift?: number; lungDensityChange?: number };
  const shift = Math.abs(body.tumorShift ?? 0);
  const weight = Math.abs(body.weightChange ?? 0);
  const density = Math.abs(body.lungDensityChange ?? 0);
  const coverage = +(96.4 - shift * .7 - weight * .18).toFixed(2);
  const lungV20 = +(21.3 + density * .8 + shift * .12).toFixed(2);
  const recommendation = coverage < 95 || lungV20 > 25 ? '需要自适应重计划评估' : '可按原计划继续治疗';
  const event = { id: `ADP-${Date.now()}`, planId: id, coverage, lungV20, anatomyChange: { weight, shift, density }, recommendation, createdAt: new Date().toISOString() };
  audits.unshift({ at: event.createdAt, action: 'adaptive_evaluation', ...event });
  return event;
});
app.post('/api/plans/:id/delivery/fractions', async req => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { fraction: number; deliveredGy: number; setupShift: { x: number; y: number; z: number } };
  const list = deliveries.get(id) ?? [];
  if (list.some(x => x.fraction === body.fraction)) return { ok: false, error: 'duplicate_fraction' };
  list.push({ ...body, at: new Date().toISOString() });
  deliveries.set(id, list);
  const magnitude = Math.hypot(body.setupShift.x, body.setupShift.y, body.setupShift.z);
  if (magnitude > 5) {
    deviations.unshift({ id: `DEV-${deviations.length + 1}`, planId: id, severity: 'high', category: 'setup_shift', detail: `第 ${body.fraction} 次摆位偏移 ${magnitude.toFixed(1)} mm`, state: 'open', createdAt: new Date().toISOString() });
  }
  audits.unshift({ at: new Date().toISOString(), action: 'fraction_delivered', planId: id, fraction: body.fraction });
  return releaseDossier(id);
});
app.post('/api/plans/:id/release', async req => {
  const id = (req.params as { id: string }).id;
  const dossier = releaseDossier(id);
  if ('error' in dossier) return dossier;
  if (dossier.gate === 'blocked') return { released: false, ...dossier };
  const plan = plans.find(p => p.id === id)!;
  plan.status = 'approved';
  audits.unshift({ at: new Date().toISOString(), action: 'plan_released', planId: id });
  return { released: true, ...releaseDossier(id) };
});
app.post('/api/plans/:id/deviations', async req => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { severity: 'low' | 'medium' | 'high'; category: string; detail: string };
  const event = { id: `DEV-${deviations.length + 1}`, planId: id, ...body, state: 'open' as const, createdAt: new Date().toISOString() };
  deviations.unshift(event);
  return event;
});

await app.listen({ host: '127.0.0.1', port: 6202 });
