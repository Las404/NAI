// Anlas / V5 사용량 배터리 조회와 이 브라우저의 소모 기록
import { getSubscription } from './nai.js';
import { token, local } from './store.js';
import { emit } from './state.js';

export const usage = { sub: null, error: null, time: 0, loading: false };
const TIERS = ['무료', 'Tablet', 'Scroll', 'Opus'];

// 응답을 화면용으로 정리
export function summarize(sub) {
  if (!sub) return null;
  const ts = sub.trainingStepsLeft || {};
  const fixed = ts.fixedTrainingStepsLeft ?? 0;
  const purchased = ts.purchasedTrainingSteps ?? 0;
  const u = sub.usage || null;
  return {
    tier: TIERS[sub.tier] ?? `tier ${sub.tier}`,
    isOpus: sub.tier === 3,
    active: sub.active,
    expiresAt: sub.expiresAt ? new Date(sub.expiresAt * 1000) : null,
    anlas: { total: fixed + purchased, fixed, purchased },
    v5: u && typeof u.percent === 'number'
      ? {
          percent: u.percent,
          negative: !!u.isNegative || u.percent < 0,
          nextPercentSec: typeof u.timeUntilNextPercent === 'number' ? u.timeUntilNextPercent : null,
          boost: typeof u.purchasedPercent === 'number' ? u.purchasedPercent : null,
        }
      : null,
  };
}

export async function refreshUsage() {
  const tk = token.get();
  if (!tk) { usage.sub = null; usage.error = null; emit('usage'); return null; }
  usage.loading = true;
  emit('usage');
  try {
    usage.sub = await getSubscription(tk);
    usage.error = null;
    usage.time = Date.now();
  } catch (e) {
    usage.error = e;
  }
  usage.loading = false;
  emit('usage');
  return usage.sub;
}

// 생성 전후 스냅샷으로 1장당 소모량 기록 (최근 300건)
export function snapshot() {
  const s = summarize(usage.sub);
  return s ? { percent: s.v5?.percent ?? null, anlas: s.anlas.total } : null;
}

export function recordGeneration(before, after, req) {
  if (!before || !after) return null;
  const entry = {
    time: Date.now(),
    model: req.model,
    steps: req.steps,
    px: req.width * req.height,
    dPercent: before.percent != null && after.percent != null ? before.percent - after.percent : null,
    dAnlas: before.anlas - after.anlas,
  };
  const log = local.get('usageLog', []);
  log.push(entry);
  local.set('usageLog', log.slice(-300));
  return entry;
}

export function usageStats() {
  const log = local.get('usageLog', []);
  const dayAgo = Date.now() - 86400000;
  const v5 = log.filter((e) => e.model?.includes('diffusion-5') && e.dPercent != null && e.dPercent >= 0);
  const recent = v5.slice(-100);
  const avgPercent = recent.length ? recent.reduce((s, e) => s + e.dPercent, 0) / recent.length : null;
  return {
    total: log.length,
    today: log.filter((e) => e.time > dayAgo).length,
    anlasToday: log.filter((e) => e.time > dayAgo && e.dAnlas > 0).reduce((s, e) => s + e.dAnlas, 0),
    avgPercent,
    sample: recent.length,
  };
}
