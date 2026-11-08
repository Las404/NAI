// WD Tagger v3 (SmilingWolf, Danbooru 태그로 학습한 애니 그림 태거) — 브라우저 안에서 실행
//  - 모델: deepghs/wd14_tagger_with_embeddings 의 wd-vit-tagger-v3 (출력 0 = 태그 확률, 출력 1 = 768차원 임베딩)
//  - 처음 한 번 약 380MB 받아서 Cache Storage에 저장, 이후엔 바로 불러옴
//  - 전처리(공식 데모와 같음): 흰 바탕에 정사각형으로 패딩 → 448×448 → BGR, 0~255 float, NHWC
const ORT_VER = '1.20.1';
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.min.mjs`;
const REPO = 'https://huggingface.co/deepghs/wd14_tagger_with_embeddings/resolve/main/SmilingWolf/wd-vit-tagger-v3/';
export const WD_MODEL_URL = REPO + 'model.onnx';
const TAGS_URL = REPO + 'tags_info.csv';
const CACHE = 'gk-wd-tagger-v3';
const SIZE = 448;
const KAOMOJI = new Set(['0_0', '(o)_(o)', '+_+', '+_-', '._.', '<o>_<o>', '<|>_<|>', '=_=', '>_<', '3_3', '6_9', '>_o', '@_@', '^_^', 'o_o', 'u_u', 'x_x', '|_|', '||_||']);

let enginePromise = null;

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    rows.push(out);
  }
  return rows;
}

// 큰 파일 저장: IndexedDB에 32MB 조각으로 (Cache Storage는 큰 파일에서 실패하는 브라우저가 있음)
const IDB = 'gk-wd-files';
const CHUNK = 32 * 1024 * 1024;
function idb() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('f');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
const idbReq = (req) => new Promise((ok, bad) => { req.onsuccess = () => ok(req.result); req.onerror = () => bad(req.error); });
async function idbLoad(url) {
  try {
    const db = await idb();
    const st = db.transaction('f').objectStore('f');
    const meta = await idbReq(st.get(url + '#meta'));
    if (!meta) return null;
    const out = new Uint8Array(meta.size);
    for (let i = 0, o = 0; i < meta.n; i++) {
      const blob = await idbReq(db.transaction('f').objectStore('f').get(`${url}#${i}`));
      if (!blob) return null;
      const part = new Uint8Array(await blob.arrayBuffer());
      out.set(part, o);
      o += part.length;
    }
    return out.buffer;
  } catch { return null; }
}
async function idbSave(url, buf) {
  try {
    const db = await idb();
    const n = Math.ceil(buf.length / CHUNK);
    for (let i = 0; i < n; i++) {
      const tx = db.transaction('f', 'readwrite');
      tx.objectStore('f').put(new Blob([buf.subarray(i * CHUNK, (i + 1) * CHUNK)]), `${url}#${i}`);
      await new Promise((ok, bad) => { tx.oncomplete = ok; tx.onerror = () => bad(tx.error); });
    }
    const tx = db.transaction('f', 'readwrite');
    tx.objectStore('f').put({ size: buf.length, n }, url + '#meta');
    await new Promise((ok, bad) => { tx.oncomplete = ok; tx.onerror = () => bad(tx.error); });
  } catch (e) { console.warn('WD 모델 저장 실패 (다음에 다시 받아요)', e); }
}

async function fetchCached(url, onProgress, big = false) {
  let cache = null;
  if (big) {
    const hit = await idbLoad(url);
    if (hit) return hit;
  } else {
    try { cache = await caches.open(CACHE); } catch { /* 캐시 못 쓰는 환경 */ }
    const hit = cache && (await cache.match(url));
    if (hit) return hit.arrayBuffer();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`모델 다운로드 실패 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (big) await idbSave(url, buf);
  else if (cache) { try { await cache.put(url, new Response(buf)); } catch { /* 저장 공간 부족 등 */ } }
  return buf.buffer;
}

export async function wdCached() {
  try {
    const db = await idb();
    return !!(await idbReq(db.transaction('f').objectStore('f').get(WD_MODEL_URL + '#meta')));
  } catch { return false; }
}

export function loadTagger(onProgress = () => {}) {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    onProgress('애니 태거 준비 중…');
    const ort = await import(ORT_URL);
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
    const [csv, model] = await Promise.all([
      fetchCached(TAGS_URL, () => {}).then((b) => new TextDecoder().decode(b)),
      fetchCached(WD_MODEL_URL, (p) => onProgress(`애니 태거 모델 받는 중… ${Math.round(p * 100)}% (처음 한 번만, 약 380MB)`), true),
    ]);
    const rows = parseCsv(csv);
    const head = rows.shift();
    const iName = head.indexOf('name'), iCat = head.indexOf('category'), iAttire = head.indexOf('is_attire');
    const labels = rows.map((r) => ({
      tag: KAOMOJI.has(r[iName]) ? r[iName] : r[iName].replace(/_/g, ' '),
      cat: Number(r[iCat]),
      attire: iAttire >= 0 && r[iAttire] === 'True',
    }));
    onProgress('애니 태거 모델 여는 중…');
    let session = null, provider = '';
    for (const ep of ['webgpu', 'wasm']) {
      try {
        if (ep === 'webgpu' && !navigator.gpu) continue;
        session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: [ep], graphOptimizationLevel: 'all' });
        provider = ep;
        break;
      } catch (e) { console.warn('WD tagger', ep, e); }
    }
    if (!session) throw new Error('애니 태거를 열 수 없어요 (브라우저가 WebGPU/WASM을 지원하지 않아요)');
    onProgress('준비 완료');
    return { ort, session, labels, provider };
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

async function toTensor(ort, blob) {
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(SIZE, SIZE);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  const k = SIZE / Math.max(bmp.width, bmp.height);
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  ctx.drawImage(bmp, Math.floor((SIZE - w) / 2), Math.floor((SIZE - h) / 2), w, h);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const arr = new Float32Array(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < SIZE * SIZE; i++, j += 3) {
    // 투명 픽셀은 흰색과 합성
    const a = d[i * 4 + 3] / 255;
    arr[j] = d[i * 4 + 2] * a + 255 * (1 - a);     // B
    arr[j + 1] = d[i * 4 + 1] * a + 255 * (1 - a); // G
    arr[j + 2] = d[i * 4] * a + 255 * (1 - a);     // R
  }
  return new ort.Tensor('float32', arr, [1, SIZE, SIZE, 3]);
}

let chain = Promise.resolve(); // 한 번에 하나씩 (GPU 세션 동시 실행 방지)

// 반환: { general: [{tag,p,attire}], characters: [{tag,p}], rating, probs, embed }
export function tagImage(blob, { general = 0.35, character = 0.85 } = {}) {
  const job = chain.then(async () => {
    const { ort, session, labels } = await loadTagger();
    const input = await toTensor(ort, blob);
    const out = await session.run({ [session.inputNames[0]]: input });
    const probs = out[session.outputNames[0]].data;
    const embRaw = session.outputNames[1] ? out[session.outputNames[1]].data : null;
    let embed = null;
    if (embRaw) {
      embed = Float32Array.from(embRaw);
      let n = 0;
      for (const x of embed) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < embed.length; i++) embed[i] /= n;
    }
    const gen = [], chars = [];
    let rating = null, rp = -1;
    labels.forEach((l, i) => {
      const p = probs[i];
      if (l.cat === 9) { if (p > rp) { rp = p; rating = l.tag; } }
      else if (l.cat === 4) { if (p >= character) chars.push({ tag: l.tag, p }); }
      else if (p >= general) gen.push({ tag: l.tag, p, attire: l.attire });
    });
    gen.sort((a, b) => b.p - a.p);
    chars.sort((a, b) => b.p - a.p);
    return { general: gen, characters: chars, rating, probs: Float32Array.from(probs), embed };
  });
  chain = job.catch(() => {});
  return job;
}

export const cosineSim = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
