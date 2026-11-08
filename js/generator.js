// 생성 실행 (모든 페이지 공용): 한 번 호출 = 한 장. 동시에 하나만.
import { MODELS, generate, clampSteps } from './nai.js';
import { buildPrompt, cloneMix } from './prompt.js';
import { history, token } from './store.js';
import { state, save, emit } from './state.js';
import { randSeed } from './ui.js';
import { refreshUsage, snapshot, recordGeneration } from './usage.js';
import { prepareAutosave, saveImage } from './autosave.js';

const join = (...parts) => parts.map((p) => (p || '').trim().replace(/^,|,$/g, '').trim()).filter(Boolean).join(', ');

// scene: { prompt, negative, size } — 씬 모드에서 기본 프롬프트 뒤에 씬 프롬프트를 붙이고 크기를 바꾼다
export function requestFrom(mix = state.mix, scene = null) {
  const s = state.settings;
  const size = scene?.size || s.size;
  const [width, height] = size.split('x').map(Number);
  const medium = !!MODELS[s.model]?.medium;
  return {
    model: s.model,
    prompt: buildPrompt({ mix, styleTags: s.styleTags, base: join(s.base, scene?.prompt), quality: s.quality, model: s.model }),
    characters: (s.characters || []).filter((c) => c.enabled !== false),
    negative: join(s.negative, scene?.negative),
    width, height,
    steps: clampSteps(s.model, s.steps),
    scale: s.scale,
    cfgRescale: s.cfgRescale,
    sampler: medium ? 'k_euler_ancestral' : s.sampler,
    seed: s.seed,
  };
}

export class NeedToken extends Error {}

// 자동 튜너용: 이미 완성된 요청(req)을 그대로 생성해서 히스토리에 저장 (자동저장·배터리 기록 포함)
// meta: { source, tuner: { runId, round, cand } , label }
export async function generateRaw(req, meta = {}) {
  const tk = token.get();
  if (!tk) throw new NeedToken('API 토큰이 필요해요');
  if (state.busy) throw new Error('이미 생성 중이에요');
  state.busy = true;
  emit('busy', true);
  const before = snapshot();
  const t0 = performance.now();
  try {
    const { blob } = await generate(tk, req);
    const item = {
      time: Date.now(), blob, mix: [], settings: JSON.parse(JSON.stringify(state.settings)),
      request: req, fav: false, source: meta.source || 'raw', ms: Math.round(performance.now() - t0),
      tuner: meta.tuner || null, label: meta.label || '',
    };
    item.id = await history.add(item);
    if (meta.autosave) {
      try { item.savedAs = await saveImage(item); if (item.savedAs) await history.put(item); } catch (e) { item.saveError = e.message; }
    }
    state.busy = false;
    emit('busy', false);
    emit('generated', item);
    const usageDone = refreshUsage().then(async () => {
      const cost = recordGeneration(before, snapshot(), req);
      if (cost) { item.cost = cost; await history.put(item); emit('cost', item); }
    });
    Object.defineProperty(item, 'usageDone', { value: usageDone, enumerable: false });
    return item;
  } catch (e) {
    state.busy = false;
    emit('busy', false);
    throw e;
  }
}

// opts.fixedSeed: true면 랜덤 시드 설정을 무시하고 현재 시드 사용
// opts.forceRandom: true면 랜덤 시드 설정과 상관없이 새 시드
// opts.scene: 씬 모드 씬 객체
export async function runGenerate(mix = state.mix, { fixedSeed = false, forceRandom = false, source = 'main', scene = null } = {}) {
  const tk = token.get();
  if (!tk) throw new NeedToken('API 토큰이 필요해요');
  if (state.busy) throw new Error('이미 생성 중이에요');
  if (forceRandom || (!fixedSeed && state.settings.randomSeed)) {
    state.settings.seed = randSeed();
    save.settings();
  }
  state.busy = true;
  emit('busy', true);
  await prepareAutosave(); // 클릭 직후라 폴더 권한 요청 가능
  const req = requestFrom(mix, scene);
  const before = snapshot();
  const t0 = performance.now();
  try {
    const { blob } = await generate(tk, req);
    const item = {
      time: Date.now(), blob, mix: cloneMix(mix), settings: JSON.parse(JSON.stringify(state.settings)),
      request: req, fav: false, source, ms: Math.round(performance.now() - t0),
    };
    if (scene) { item.sceneId = scene.id; item.sceneName = scene.name; item.scene = { prompt: scene.prompt, negative: scene.negative, size: scene.size }; }
    item.id = await history.add(item);
    try {
      item.savedAs = await saveImage(item);
      if (item.savedAs) await history.put(item);
    } catch (e) {
      item.saveError = e.message;
    }
    state.busy = false;
    emit('busy', false);
    emit('generated', item);
    // 사용량 갱신 후 이번 생성의 소모량 기록 (큐는 이 결과를 보고 배터리 소진 여부를 판단)
    const usageDone = refreshUsage().then(async () => {
      const cost = recordGeneration(before, snapshot(), req);
      if (cost) { item.cost = cost; await history.put(item); emit('cost', item); }
    });
    // IndexedDB에 저장되지 않도록 열거 불가 속성으로
    Object.defineProperty(item, 'usageDone', { value: usageDone, enumerable: false });
    return item;
  } catch (e) {
    state.busy = false;
    emit('busy', false);
    throw e;
  }
}
