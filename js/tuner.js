// 자동 그림체 튜너 엔진
// 예시 이미지 → (Claude 분석 + CLIP 후보) → [K장 생성 → CLIP 점수 → Claude 평가·다음 후보] 반복 → 최종 프롬프트·네거티브·설정
import { state, emit } from './state.js';
import { MODELS, SAMPLERS } from './nai.js';
import { generateRaw } from './generator.js';
import { usage, summarize } from './usage.js';
import { history } from './store.js';
import { randSeed } from './ui.js';
import { askClaude, blobToClaudeImage, costOf, ClaudeError } from './claude.js';
import { analyzeImage, embedStyle, cosine } from './clip.js';
import { loadStyleGroups } from './stylepicker.js';
import { queue } from './queue.js';

export const MAX_BUDGET = 200;

// ───────── Claude에게 주는 지침 ─────────
const SYSTEM = `You are an expert NovelAI Diffusion (V4.5/V5) prompt engineer who reverse-engineers an illustration's ART STYLE into a reusable prompt.

The user gives a reference image. A program renders your candidate prompts with the NovelAI API and shows you the results next to the reference, round after round. Your job: make the generated art style match the reference as closely as possible, then hand back a reusable MAIN STYLE PROMPT, NEGATIVE PROMPT and SETTINGS.

What "style" means here: line work (thickness, color, cleanliness), coloring/shading method (cel, soft, painterly, rim light, gradients), color palette and saturation, contrast, eye rendering, face/body proportions, skin and hair rendering, level of detail and complexity, lighting, overall era/finish. NOT the subject, pose, outfit or background content.

Prompt rules (NovelAI V5):
- Comma-separated Danbooru tags plus optional short natural language.
- Numeric weights: "1.3::tag1, tag2::" strengthens, "0.6::tag::" weakens, negative weights "-1::tag::" push away (V4.5+). Braces {tag} = x1.05, [tag] = /1.05. Keep weights roughly within -3..2.5.
- Artist tags: "artist:name" (Danbooru artist tag, spaces instead of underscores). Mixing 2-6 artists with weights 0.2-1.2 is the main style lever. A bare artist name without "artist:" also works but is weaker/less predictable; prefer "artist:".
- Useful style tags: medium tags (e.g. "watercolor (medium)"), "anime coloring", "flat color", "painterly", "lineart", "no lineart", "ligne claire", "realistic", color tags ("vibrant colors", "muted color", "pastel colors", "high contrast"), effects ("chromatic aberration", "bloom", "depth of field"), "year 2024"-style era tags, V5-only "low/medium/high/ultra complexity", "meta:novel era", "meta:golden era", "depthness".
- Quality tags belong in the main style prompt (e.g. "masterpiece, best quality, very aesthetic, absurdres") — the program does NOT add any automatically.
- The style prompt must NOT contain subject/content tags (no 1girl, hair color, clothing, pose, background objects). Content is handled separately by CONTENT PROMPT so every candidate draws comparable content.
- Never remove or contradict the LOCKED tags; the program always appends them.
- Settings: scale (CFG) 3-7 typical, cfg_rescale 0-0.5, steps <= 28 (higher costs the user money), sampler from the allowed list. Lower CFG = softer/more painterly, higher = crisper/more saturated; rescale tames oversaturation at high CFG.

Strategy:
- Early rounds: explore broadly — different artist combinations (use the CLIP-suggested artists, which come from real NovelAI V5 renders of each artist, but also your own knowledge), very different weights.
- Middle rounds: exploit the best candidates — tweak weights, add/remove style and quality tags, start shaping the negative prompt.
- Late rounds: tune the negative prompt and settings (CFG, rescale, steps, sampler) around the best prompt, small steps.
- Each round's candidates should differ from each other in a deliberate, informative way (an experiment), not be random.
- Judge style match honestly; ignore differences in content/pose. Be specific in notes (e.g. "lines too thick", "eyes too glossy", "palette too warm").

Write every human-readable field (analysis, critique, notes, rationale, summary) in Korean, short and concrete. Tags stay in English.`;

const SETTINGS_PROPS = {
  scale: { type: 'number', description: 'CFG scale' },
  cfg_rescale: { type: 'number' },
  steps: { type: 'integer', description: '<= 28' },
  sampler: { type: 'string', enum: SAMPLERS },
};
const CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  required: ['rationale', 'style_prompt', 'negative_prompt', ...Object.keys(SETTINGS_PROPS)],
  properties: {
    rationale: { type: 'string', description: '무엇을 시험하는 후보인지 (한국어 한 줄)' },
    style_prompt: { type: 'string', description: 'artist tags + style tags + quality tags, no content tags' },
    negative_prompt: { type: 'string' },
    ...SETTINGS_PROPS,
  },
};
const RANKING = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['id', 'score', 'note'],
    properties: { id: { type: 'string' }, score: { type: 'number', description: '0-10 style match to the reference' }, note: { type: 'string' } },
  },
};
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['analysis', 'content_prompt', 'candidates'],
  properties: {
    analysis: { type: 'string', description: '레퍼런스 그림체 분석 (한국어)' },
    content_prompt: { type: 'string', description: 'Danbooru tags describing the reference SUBJECT/composition/background only (no style tags)' },
    candidates: { type: 'array', items: CANDIDATE },
  },
};
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['critique', 'ranking', 'candidates'],
  properties: { critique: { type: 'string' }, ranking: RANKING, candidates: { type: 'array', items: CANDIDATE } },
};
const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ranking', 'winner_id', 'summary', 'style_prompt', 'negative_prompt', ...Object.keys(SETTINGS_PROPS)],
  properties: {
    ranking: RANKING, winner_id: { type: 'string' }, summary: { type: 'string' },
    style_prompt: { type: 'string' }, negative_prompt: { type: 'string' }, ...SETTINGS_PROPS,
  },
};

// ───────── 상태 ─────────
export const tuner = {
  run: null,
  get running() { return !!this.run && ['analyzing', 'generating', 'judging', 'validating'].includes(this.run.status); },
};
const emitT = () => emit('tuner');
const log = (msg, kind = '') => { tuner.run.log.unshift({ time: Date.now(), msg, kind }); emitT(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const join = (...p) => p.map((x) => (x || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

function sizeFor(w, h) {
  const r = w / h;
  if (r < 0.85) return [832, 1216];
  if (r > 1.18) return [1216, 832];
  return [1024, 1024];
}

function normalizeCand(c, id, round) {
  return {
    id, round,
    rationale: c.rationale || '',
    style_prompt: (c.style_prompt || '').trim(),
    negative_prompt: (c.negative_prompt || '').trim(),
    scale: clamp(c.scale, 1, 10, 5),
    cfg_rescale: clamp(c.cfg_rescale, 0, 1, 0),
    steps: Math.round(clamp(c.steps, 10, 28, 23)),
    sampler: SAMPLERS.includes(c.sampler) ? c.sampler : 'k_euler_ancestral',
    images: [], claude: null, note: '',
  };
}

function requestFor(run, cand, seed) {
  return {
    model: run.model,
    prompt: join(cand.style_prompt, run.content, run.lockedPos),
    characters: [],
    negative: join(cand.negative_prompt, run.lockedNeg),
    width: run.width, height: run.height,
    steps: cand.steps, scale: cand.scale, cfgRescale: cand.cfg_rescale, sampler: cand.sampler,
    seed,
  };
}

// 종합 점수: Claude 점수(0~10) 70% + CLIP 유사도(이번 실행 안에서 0~1로 정규화) 30%
export function scoreOf(run, cand) {
  const clips = run.cands.flatMap((c) => c.images.map((i) => i.clip)).filter((x) => x != null);
  const lo = Math.min(...clips), hi = Math.max(...clips);
  const clip = cand.images.length ? cand.images.reduce((a, i) => a + i.clip, 0) / cand.images.length : null;
  const clipN = clip == null || hi === lo ? 0.5 : (clip - lo) / (hi - lo);
  const cl = cand.claude == null ? null : cand.claude / 10;
  return { total: cl == null ? clipN * 0.3 : cl * 0.7 + clipN * 0.3, clip, clipN };
}

export function leaderboard(run, n = 6) {
  return run.cands.filter((c) => c.images.length).map((c) => ({ c, s: scoreOf(run, c) })).sort((a, b) => b.s.total - a.s.total).slice(0, n);
}

function candText(c, s) {
  return `[${c.id}] total=${s ? s.total.toFixed(3) : '-'} claude=${c.claude ?? '-'} clip=${s?.clip != null ? s.clip.toFixed(4) : '-'}
  style_prompt: ${c.style_prompt}
  negative_prompt: ${c.negative_prompt || '(none)'}
  settings: scale=${c.scale}, cfg_rescale=${c.cfg_rescale}, steps=${c.steps}, sampler=${c.sampler}
  note: ${c.note || '-'}`;
}

function phaseHint(run) {
  const p = run.used / run.budget;
  if (p < 0.35) return 'PHASE: EXPLORE — try clearly different artist combinations and weights.';
  if (p < 0.65) return 'PHASE: REFINE — build on the leaderboard: tune artist weights, style tags and quality tags; start shaping the negative prompt.';
  if (p < 0.85) return 'PHASE: NEGATIVE & SETTINGS — keep the best style prompt mostly fixed; vary the negative prompt and settings (CFG, rescale, steps, sampler).';
  return 'PHASE: POLISH — small, careful changes around the current best.';
}

// ───────── 실행 ─────────
export function createRun(opts) {
  return {
    id: 't' + Date.now(),
    status: 'idle', stopping: false, error: null,
    refBlob: opts.refBlob, refUrl: URL.createObjectURL(opts.refBlob), refVec: null, refImg: null,
    mode: opts.mode, // 'current' | 'fresh'
    startPos: opts.startPos || '', startNeg: opts.startNeg || '',
    lockedPos: opts.lockedPos || '', lockedNeg: opts.lockedNeg || '',
    budget: Math.min(MAX_BUDGET, Math.max(8, opts.budget)), batch: Math.max(2, Math.min(12, opts.batch)),
    model: MODELS[opts.model]?.medium ? 'nai-diffusion-5-full' : opts.model,
    width: 832, height: 1216, content: opts.content || '',
    seeds: [randSeed(), randSeed()],
    used: 0, round: 0, cost: 0,
    cands: [], pending: [], rounds: [], analysis: '', clipHints: '', final: null, log: [],
  };
}

export async function startRun(run) {
  tuner.run = run;
  state.lock = 'tuner';
  try {
    if (!run.refVec) await analyze(run);
    await loop(run);
    if (!run.stopping && !run.error) await finish(run);
  } catch (e) {
    run.error = e.message;
    run.status = 'error';
    log('❌ ' + e.message, 'bad');
  } finally {
    if (run.status !== 'error') run.status = run.final ? 'done' : 'stopped';
    run.stopping = false;
    state.lock = null;
    emitT();
    emit('queue');
  }
}

export function stopRun() {
  if (tuner.run && tuner.running) { tuner.run.stopping = true; log('정지 요청 — 지금 단계가 끝나면 멈춰요'); }
}

async function analyze(run) {
  run.status = 'analyzing';
  log('예시 이미지 분석 중 (CLIP)…');
  const bmp = await createImageBitmap(run.refBlob);
  [run.width, run.height] = sizeFor(bmp.width, bmp.height);
  run.refVec = await embedStyle(run.refBlob);
  const groups = await loadStyleGroups();
  const res = await analyzeImage(run.refBlob, { exclude: state.hidden, groups });
  const top = res.artists.slice(0, 40);
  const best = top[0]?.sim || 1;
  run.clipHints = 'CLIP artist candidates (similarity of each artist\'s NovelAI V5 sample render to the reference, 100 = best match):\n'
    + top.map((a) => `artist:${a.tag} (${Math.round((a.sim / best) * 100)})`).join(', ')
    + '\n\nCLIP style-tag hints (z-score within group, higher = more prominent):\n'
    + Object.entries(res.styles).map(([g, list]) => `${g}: ` + list.slice(0, 5).map((s) => `${s.tag} (${s.score.toFixed(1)})`).join(', ')).join('\n');
  run.refImg = await blobToClaudeImage(run.refBlob, 1024);
  run.refImg.cache_control = { type: 'ephemeral' }; // 매 라운드 같은 앞부분 → 캐시

  log('Claude가 그림체를 분석하고 첫 후보를 짜는 중…');
  const k = Math.min(run.batch, run.budget);
  const start = run.mode === 'current'
    ? `STARTING POINT (the user's current prompts — refine from here; candidate 1 should be close to it so we get a baseline):\nMAIN: ${run.startPos || '(empty)'}\nNEGATIVE: ${run.startNeg || '(empty)'}`
    : 'STARTING POINT: none — design from the reference image.';
  const { data, usage: u } = await askClaude({
    system: SYSTEM,
    schema: PLAN_SCHEMA,
    content: [
      { type: 'text', text: 'REFERENCE IMAGE:' },
      run.refImg,
      { type: 'text', text: `${start}

LOCKED (always appended by the program, keep compatible): positive="${run.lockedPos}" negative="${run.lockedNeg}"
Output size ${run.width}x${run.height}, model ${run.model}. Allowed samplers: ${SAMPLERS.join(', ')}.
Budget: ${run.budget} images total, ${k} candidates per round (1 image each, same seed within a round).

${run.clipHints}

Task: analyze the reference style, write CONTENT_PROMPT (subject/composition/background tags of the reference so renders are comparable — keep it moderate, ~10-25 tags), and propose exactly ${k} first-round candidates.` },
    ],
  });
  run.cost += costOf(u);
  run.analysis = data.analysis;
  if (!run.content) run.content = data.content_prompt;
  run.pending = data.candidates.slice(0, k).map((c, i) => normalizeCand(c, `r1c${i + 1}`, 1));
  run.round = 1;
  log(`분석 완료 · 후보 ${run.pending.length}개 (Claude 비용 약 $${costOf(u).toFixed(3)})`, 'good');
}

function checkLimits(run) {
  const s = summarize(usage.sub);
  if (queue.stopOnEmpty && MODELS[run.model]?.v5 && s?.v5?.negative) throw new Error('V5 배터리가 바닥나서 멈췄어요');
}

async function renderCands(run, cands, seedOf) {
  for (const c of cands) {
    if (run.stopping) return false;
    if (run.used >= run.budget) return true;
    const seed = seedOf(c);
    const req = requestFor(run, c, seed);
    let item;
    for (let attempt = 0; ; attempt++) {
      try {
        item = await generateRaw(req, { source: 'tuner', tuner: { runId: run.id, round: c.round, cand: c.id }, label: `튜너 ${c.id}` });
        break;
      } catch (e) {
        if (e.status === 429 && attempt === 0) { log('NAI 429 — 15초 기다렸다 다시 시도'); await sleep(15000); continue; }
        throw e;
      }
    }
    run.used++;
    const clip = cosine(run.refVec, await embedStyle(item.blob));
    c.images.push({ itemId: item.id, seed, clip, blob: item.blob, url: URL.createObjectURL(item.blob) });
    log(`${c.id} 생성 (${run.used}/${run.budget}) · CLIP ${clip.toFixed(3)}`);
    await item.usageDone;
    checkLimits(run);
    if (run.used < run.budget && !run.stopping) {
      const until = Date.now() + queue.delay * 1000;
      while (Date.now() < until && !run.stopping) await sleep(200);
    }
  }
  return true;
}

// 새 이미지 없이 다음 후보만 받기 (이어하기 등)
async function proposeOnly(run, k) {
  run.status = 'judging';
  log('다음 후보를 짜는 중 (Claude)…');
  const board = leaderboard(run);
  const { data, usage: u } = await askClaude({
    system: SYSTEM, schema: JUDGE_SCHEMA,
    content: [
      { type: 'text', text: 'REFERENCE IMAGE:' }, run.refImg,
      { type: 'text', text: `CONTENT_PROMPT: ${run.content}\nLOCKED: positive="${run.lockedPos}" negative="${run.lockedNeg}"\nReference style analysis: ${run.analysis}\n\nLEADERBOARD:\n${board.map(({ c, s }) => candText(c, s)).join('\n')}\n\nPrevious critiques:\n${run.rounds.slice(-3).map((r) => `round ${r.round}: ${r.critique}`).join('\n')}\n\nImages used: ${run.used}/${run.budget}. ${phaseHint(run)}\nNo new renders this time: return an empty "ranking", a one-line critique of the current best, and exactly ${k} new candidates.` },
    ],
  });
  run.cost += costOf(u);
  run.round++;
  run.pending = data.candidates.slice(0, k).map((c, i) => normalizeCand(c, `r${run.round}c${i + 1}`, run.round));
}

async function loop(run) {
  const reserve = run.budget >= 30 ? Math.min(6, Math.floor(run.budget * 0.1)) : 0; // 마지막 검증용
  while (!run.stopping) {
    if (!run.pending.length) {
      const k = Math.min(run.batch, run.budget - reserve - run.used);
      if (k <= 0 || !run.cands.length) break;
      await proposeOnly(run, k);
      if (!run.pending.length) break;
    }
    const cands = run.pending;
    run.pending = [];
    run.cands.push(...cands);
    run.status = 'generating';
    emitT();
    const seed = run.seeds[(run.round - 1) % 2];
    await renderCands(run, cands, () => seed);
    if (run.stopping) {
      // 정지: 아직 안 그린 후보는 다음에 이어서 그리도록 되돌려 둠 (Claude 평가는 건너뜀)
      const undone = cands.filter((c) => !c.images.length);
      run.cands = run.cands.filter((c) => !undone.includes(c));
      run.pending = undone;
      break;
    }
    // 이번 라운드에서 그렸지만 아직 평가 안 받은 후보 전부 (정지 후 이어한 경우 포함)
    const done = run.cands.filter((c) => c.round === run.round && c.images.length && c.claude == null);
    if (!done.length) break;

    // Claude 평가 + 다음 후보
    run.status = 'judging';
    const remaining = Math.max(0, run.budget - reserve - run.used);
    const k = Math.min(run.batch, remaining);
    log(`라운드 ${run.round} 평가 중 (Claude)…`);
    const board = leaderboard(run);
    const content = [
      { type: 'text', text: 'REFERENCE IMAGE:' }, run.refImg,
      { type: 'text', text: `CONTENT_PROMPT used for all renders: ${run.content}\nLOCKED: positive="${run.lockedPos}" negative="${run.lockedNeg}"\nReference style analysis: ${run.analysis}\n\nROUND ${run.round} RESULTS (same seed ${seed}):` },
    ];
    for (const c of done) {
      content.push({ type: 'text', text: candText(c, scoreOf(run, c)) });
      content.push(await blobToClaudeImage(c.images[0].blob, 640));
    }
    const prevCrit = run.rounds.slice(-3).map((r) => `round ${r.round}: ${r.critique}`).join('\n');
    content.push({ type: 'text', text: `LEADERBOARD SO FAR (before this round's scores; total = 0.7*claude/10 + 0.3*normalized CLIP):\n${board.map(({ c, s }) => candText(c, s)).join('\n') || '(empty)'}

Previous critiques:\n${prevCrit || '(none)'}

${run.clipHints}

Images used: ${run.used}/${run.budget} (${reserve} reserved for final validation). ${phaseHint(run)}
Task: score every candidate of round ${run.round} in "ranking" (ids: ${done.map((c) => c.id).join(', ')}), write a short critique of what still differs from the reference, then propose exactly ${k} new candidates for the next round${k === 0 ? ' (0 = return an empty list)' : ''}.` });
    const { data, usage: u } = await askClaude({ system: SYSTEM, schema: JUDGE_SCHEMA, content });
    run.cost += costOf(u);
    for (const r of data.ranking) {
      const c = done.find((x) => x.id === r.id);
      if (c) { c.claude = clamp(r.score, 0, 10, null); c.note = r.note; }
    }
    run.rounds.push({ round: run.round, critique: data.critique });
    const top = leaderboard(run, 1)[0];
    log(`라운드 ${run.round}: ${data.critique} · 현재 1위 ${top?.c.id} (${top ? top.s.total.toFixed(2) : '-'}) · 누적 Claude 비용 $${run.cost.toFixed(2)}`, 'good');
    run.round++;
    run.pending = data.candidates.slice(0, k).map((c, i) => normalizeCand(c, `r${run.round}c${i + 1}`, run.round));
    emitT();
  }
}

async function finish(run) {
  const board = leaderboard(run, 3);
  if (!board.length) return;
  const left = run.budget - run.used;
  // 검증: 상위 후보를 새 시드로 다시 그려서 우연히 잘 나온 것인지 확인
  if (left >= 2 && board.length >= 2) {
    run.status = 'validating';
    const seeds = [randSeed(), randSeed()];
    log(`검증: 상위 ${board.length}개 후보를 새 시드로 다시 생성`);
    const vc = [];
    for (const seed of seeds) for (const { c } of board) vc.push({ c, seed });
    for (const { c, seed } of vc.slice(0, left)) {
      if (run.stopping) break;
      await renderCands(run, [c], () => seed);
    }
  }
  if (run.stopping) return;
  run.status = 'judging';
  log('최종 결과 정리 중 (Claude)…');
  const content = [
    { type: 'text', text: 'REFERENCE IMAGE:' }, run.refImg,
    { type: 'text', text: `CONTENT_PROMPT used for renders: ${run.content}\nLOCKED: positive="${run.lockedPos}" negative="${run.lockedNeg}"\n\nFINAL CANDIDATES (each rendered with several seeds):` },
  ];
  for (const { c, s } of board) {
    content.push({ type: 'text', text: candText(c, s) });
    for (const im of c.images.slice(0, 3)) content.push(await blobToClaudeImage(im.blob, 512));
  }
  content.push({ type: 'text', text: `Rank these finalists by consistent style match across seeds, pick the winner, and output the FINAL reusable main style prompt (artists + style + quality tags, NO content tags — the user will add their own subject), negative prompt and settings. You may apply small final fixes you are confident about. "summary": explain in Korean what the style is and what each part of the prompt does.` });
  const { data, usage: u } = await askClaude({ system: SYSTEM, schema: FINAL_SCHEMA, content, effort: 'high' });
  run.cost += costOf(u);
  run.final = normalizeCand(data, 'final', run.round);
  run.final.summary = data.summary;
  run.final.winner = data.winner_id;
  for (const r of data.ranking) { const c = run.cands.find((x) => x.id === r.id); if (c) c.note = r.note; }
  run.status = 'done';
  log(`완료! 우승 ${data.winner_id} · 생성 ${run.used}장 · Claude 비용 약 $${run.cost.toFixed(2)}`, 'good');
  // 결과 보관
  const saved = JSON.parse(localStorage.getItem('gk.tunerResults') || '[]');
  saved.unshift({ time: Date.now(), runId: run.id, ...run.final, lockedPos: run.lockedPos, lockedNeg: run.lockedNeg, model: run.model });
  localStorage.setItem('gk.tunerResults', JSON.stringify(saved.slice(0, 30)));
}

// 끝난(또는 멈춘) 실행을 이어서 더 돌리기
export async function continueRun(run, extra) {
  run.budget = Math.min(MAX_BUDGET, run.budget + extra);
  run.final = null;
  run.error = null;
  return startRun(run); // 남은 후보가 없으면 loop에서 Claude에게 새 후보를 받아요
}

export async function historyItemsOf(run) {
  const all = await history.all();
  return all.filter((i) => i.tuner?.runId === run.id);
}

export { ClaudeError };
