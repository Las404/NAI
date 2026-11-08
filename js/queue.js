// 예약 생성 큐: 여러 장을 간격을 두고 차례로 생성. 언제든 정지 가능.
// 안전장치: 한 번에 최대 MAX_JOBS장, 간격 최소 MIN_DELAY초, V5 배터리 소진 시 자동 정지, 오류 시 정지
import { state, emit } from './state.js';
import { local } from './store.js';
import { MODELS, isOpusFree, NaiError } from './nai.js';
import { runGenerate, requestFrom, NeedToken } from './generator.js';
import { usage, summarize } from './usage.js';

export const MAX_JOBS = 100;
export const MIN_DELAY = 2;

export const queue = {
  jobs: [],      // [{ mix, scene, label }]
  done: 0,
  running: false,
  stopping: false,
  error: null,
  waitUntil: 0,
  get delay() { return Math.max(MIN_DELAY, Number(local.get('queueDelay', 3))); },
  set delay(v) { local.set('queueDelay', Math.max(MIN_DELAY, Number(v) || MIN_DELAY)); emit('queue'); },
  get stopOnEmpty() { return local.get('queueStopOnEmpty', true); },
  set stopOnEmpty(v) { local.set('queueStopOnEmpty', !!v); emit('queue'); },
};

export const ackKey = 'queueAck';
export const acknowledged = () => !!local.get(ackKey, false);
export function acknowledge() { local.set(ackKey, true); }

// 시작 전 점검: 반환값이 문자열이면 확인 메시지
export function preflight(jobs) {
  const warns = [];
  const paid = jobs.filter((j) => !isOpusFree(requestFrom(j.mix, j.scene))).length;
  if (paid) warns.push(`${paid}장은 무료 조건(1MP·28스텝 이하)을 넘어서 Anlas가 들어요.`);
  const s = summarize(usage.sub);
  if (MODELS[state.settings.model]?.v5 && s?.v5) {
    if (s.v5.negative) warns.push('V5 배터리가 이미 바닥이라 모든 장에 Anlas가 들어요.');
  }
  return warns;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runQueue(jobs) {
  if (queue.running) throw new Error('이미 예약 생성 중이에요');
  if (!jobs.length) return;
  queue.jobs = jobs.slice(0, MAX_JOBS);
  queue.done = 0;
  queue.running = true;
  queue.stopping = false;
  queue.error = null;
  emit('queue');
  let retried = false;
  try {
    while (queue.done < queue.jobs.length && !queue.stopping) {
      const job = queue.jobs[queue.done];
      try {
        const item = await runGenerate(job.mix, { forceRandom: true, source: job.scene ? 'scene' : 'queue', scene: job.scene });
        retried = false;
        queue.done++;
        emit('queue');
        await item.usageDone;
        const s = summarize(usage.sub);
        if (queue.stopOnEmpty && MODELS[state.settings.model]?.v5 && s?.v5?.negative && queue.done < queue.jobs.length) {
          queue.error = 'V5 배터리가 바닥나서 멈췄어요 (설정에서 끌 수 있어요)';
          break;
        }
      } catch (e) {
        if (e instanceof NaiError && e.status === 429 && !retried) {
          retried = true;
          queue.waitUntil = Date.now() + 15000;
          emit('queue');
          await sleep(15000);
          continue;
        }
        queue.error = e instanceof NeedToken ? 'API 토큰이 필요해요' : e.message;
        break;
      }
      if (queue.done < queue.jobs.length && !queue.stopping) {
        queue.waitUntil = Date.now() + queue.delay * 1000;
        emit('queue');
        // 간격 대기 (정지 누르면 바로 빠져나옴)
        while (Date.now() < queue.waitUntil && !queue.stopping) await sleep(200);
        queue.waitUntil = 0;
      }
    }
  } finally {
    queue.running = false;
    queue.stopping = false;
    queue.waitUntil = 0;
    emit('queue');
    emit('queueDone', { done: queue.done, total: queue.jobs.length, error: queue.error });
  }
}

export function stopQueue() {
  if (!queue.running) return;
  queue.stopping = true;
  emit('queue');
}
