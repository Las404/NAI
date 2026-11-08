// 그림체 분석 엔진: 업로드 이미지를 CLIP으로 임베딩 → nax 샘플 임베딩과 비교 → 비슷한 작가 + 화풍 태그 추천
// 사전 계산 데이터: assets/clip/index.json, embeds.i8, style-text.json (tools/embed*.html 로 생성)
import { styleVector } from './clipfeat.js';

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
let enginePromise = null;

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function hasClipData() {
  return fetch(new URL('../assets/clip/index.json', import.meta.url), { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
}

export function loadEngine(onProgress = () => {}) {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    onProgress('분석 데이터 불러오는 중…');
    const base = new URL('../assets/clip/', import.meta.url);
    const [index, buf, style, tf] = await Promise.all([
      fetch(new URL('index.json', base)).then((r) => { if (!r.ok) throw new Error('분석 데이터가 아직 없어요'); return r.json(); }),
      fetch(new URL('embeds.i8', base)).then((r) => r.arrayBuffer()),
      fetch(new URL('style-text.json', base)).then((r) => (r.ok ? r.json() : null)),
      import(TRANSFORMERS),
    ]);
    const { dim, scale, tags } = index;
    // 역양자화 → 재정규화 (평균 빼기는 실험에서 오히려 정확도를 떨어뜨려서 안 함)
    const q = new Int8Array(buf);
    const vecs = new Float32Array(tags.length * dim);
    for (let i = 0; i < tags.length; i++) {
      const v = vecs.subarray(i * dim, (i + 1) * dim);
      for (let d = 0; d < dim; d++) v[d] = q[i * dim + d] / scale;
      normalize(v);
    }
    let styleVecs = null;
    if (style) {
      styleVecs = {};
      for (const [tag, arr] of Object.entries(style.tags)) styleVecs[tag] = normalize(Float32Array.from(arr, (x) => x / style.scale));
    }
    onProgress('CLIP 모델 불러오는 중… (처음 한 번 약 90MB, 이후엔 캐시)');
    const opts = {
      dtype: index.dtype || 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) onProgress(`CLIP 모델 받는 중… ${Math.round((p.loaded / p.total) * 100)}%`);
      },
    };
    const processor = await tf.AutoProcessor.from_pretrained(index.model);
    const model = await tf.CLIPVisionModelWithProjection.from_pretrained(index.model, opts);
    onProgress('준비 완료');
    return { index, tags, dim, vecs, styleVecs, processor, model, RawImage: tf.RawImage };
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

// 그림체 특징 벡터 하나만 (자동 튜너 점수용)
export async function embedStyle(blob) {
  return styleVector(await loadEngine(), blob);
}
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function embedWhole(eng, blob) {
  const image = await eng.RawImage.fromBlob(blob);
  const { image_embeds } = await eng.model(await eng.processor(image));
  return normalize(Float32Array.from(image_embeds.data));
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 반환: { artists: [{ tag, sim, idx }], styles: { [groupId]: [{ tag, score }] }, pick(k, diversity) }
export async function analyzeImage(blob, { exclude = new Set(), groups = [] } = {}) {
  const eng = await loadEngine();
  const query = await styleVector(eng, blob); // 작가 비교용 (전체 + 조각)
  const raw = await embedWhole(eng, blob);    // 화풍 태그 비교용 (전체)

  const scored = [];
  for (let i = 0; i < eng.tags.length; i++) {
    if (exclude.has(eng.tags[i])) continue;
    scored.push({ tag: eng.tags[i], idx: i, sim: dot(query, eng.vecs.subarray(i * eng.dim, (i + 1) * eng.dim)) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const artists = scored.slice(0, 80);

  // 화풍 태그: 같은 그룹 안에서 상대 점수(z-score)
  const styles = {};
  if (eng.styleVecs) {
    for (const g of groups) {
      if (g.id === 'v5') continue;
      const list = g.tags.filter(([t]) => eng.styleVecs[t]).map(([t, desc]) => ({ tag: t, desc, s: dot(raw, eng.styleVecs[t]) }));
      if (!list.length) continue;
      const m = list.reduce((a, x) => a + x.s, 0) / list.length;
      const sd = Math.sqrt(list.reduce((a, x) => a + (x.s - m) ** 2, 0) / list.length) || 1;
      styles[g.id] = list.map((x) => ({ tag: x.tag, desc: x.desc, score: (x.s - m) / sd })).sort((a, b) => b.score - a.score);
    }
  }

  // 다양성을 고려해 k명 고르기 (MMR) + 유사도에 비례한 가중치
  const pick = (k = 3, diversity = 0.35) => {
    const pool = artists.slice(0, 60);
    const chosen = [];
    while (chosen.length < k && pool.length) {
      let best = -Infinity, bi = 0;
      pool.forEach((c, i) => {
        const red = chosen.length
          ? Math.max(...chosen.map((s) => dot(eng.vecs.subarray(c.idx * eng.dim, (c.idx + 1) * eng.dim), eng.vecs.subarray(s.idx * eng.dim, (s.idx + 1) * eng.dim))))
          : 0;
        const score = (1 - diversity) * c.sim - diversity * red;
        if (score > best) { best = score; bi = i; }
      });
      chosen.push(pool.splice(bi, 1)[0]);
    }
    const sims = chosen.map((c) => c.sim);
    const hi = Math.max(...sims), lo = Math.min(...sims);
    return chosen.map((c) => ({
      tag: c.tag,
      sim: c.sim,
      weight: chosen.length === 1 || hi === lo ? 1 : Math.round((0.7 + 0.6 * (c.sim - lo) / (hi - lo)) * 20) / 20,
    }));
  };

  return { artists, styles, pick };
}
