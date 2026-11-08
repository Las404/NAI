// 자동 그림체 튜너 엔진
// 예시 이미지 → (Claude 분석 + CLIP 후보) → [K장 생성 → CLIP 점수 → Claude 평가·다음 후보] 반복 → 최종 프롬프트·네거티브·설정
import { state, emit, DEFAULT_NEG } from './state.js';
import { extractArtists, fmtWeight } from './prompt.js';
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
  get running() { return !!this.run && ['analyzing', 'generating', 'judging', 'validating', 'picking'].includes(this.run.status); },
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

// 종합 점수
//  - Claude 두뇌: Claude 점수(0~10) 70% + CLIP 유사도(이번 실행 안에서 0~1 정규화) 30%
//  - CLIP 두뇌: CLIP 유사도(정규화) + 내가 👍한 후보 보너스 1
export function scoreOf(run, cand) {
  const clips = run.cands.flatMap((c) => c.images.map((i) => i.clip)).filter((x) => x != null);
  const lo = Math.min(...clips), hi = Math.max(...clips);
  const clip = cand.images.length ? cand.images.reduce((a, i) => a + i.clip, 0) / cand.images.length : null;
  const clipN = clip == null || hi === lo ? 0.5 : (clip - lo) / (hi - lo);
  if (run.brain === 'clip') return { total: clipN + (cand.picked ? 1 : 0), clip, clipN };
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
    brain: opts.brain || 'clip', humanPick: !!opts.humanPick, waitingPick: false,
    startSettings: opts.startSettings || null, // CLIP 두뇌 + 현재 프롬프트 출발일 때 설정
  };
}

export async function startRun(run) {
  tuner.run = run;
  state.lock = 'tuner';
  try {
    if (run.brain === 'clip') {
      if (!run.refVec) await clipAnalyze(run);
      await clipLoop(run);
      if (!run.stopping && !run.error) await clipFinish(run);
    } else {
      if (!run.refVec) await analyze(run);
      await loop(run);
      if (!run.stopping && !run.error) await finish(run);
    }
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
  if (tuner.run && tuner.running) {
    tuner.run.stopping = true;
    log('정지 요청 — 지금 단계가 끝나면 멈춰요');
    if (tuner.run.pickResolve) tuner.run.pickResolve();
  }
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

// ═════════════════════════ CLIP 두뇌 (무료) ═════════════════════════
// 점수 = 예시와 생성 이미지의 CLIP 그림체 유사도. 모든 라운드가 같은 시드라 서로 비교 가능.
// 단계: ① 작가 단독 시험 → ② 작가 조합·가중치 진화 → ③ 화풍 태그 넣고 빼기 → ④ 설정·부정 프롬프트 → ⑤ 새 시드로 검증

let contentGroupsPromise;
const loadContentGroups = () => (contentGroupsPromise ||= fetch(new URL('../assets/content-tags.json', import.meta.url)).then((r) => r.json()).then((j) => j.groups));

// 예시 이미지 분석 (시작 전에 미리 볼 수 있게 export): 내용 프롬프트 추정 + 작가 후보 + 화풍 힌트
export async function analyzeReference(blob) {
  const [styleGroups, contentGroups] = await Promise.all([loadStyleGroups(), loadContentGroups()]);
  const res = await analyzeImage(blob, { exclude: state.hidden, groups: [...styleGroups, ...contentGroups] });
  const content = [];
  for (const g of contentGroups) {
    const list = res.styles[g.id];
    if (!list?.length) continue;
    // CLIP 추정은 틀릴 수 있어서, 확실히 두드러질 때만 넣음 (틀린 태그보다 빠진 태그가 나음)
    const need = g.id === 'c_frame' ? 1.2 : ['c_clothes', 'c_bg'].includes(g.id) ? 2.1 : 1.6;
    for (const s of list.slice(0, g.pick)) if (s.score > need) content.push(s.tag);
  }
  const styleHints = [];
  for (const g of styleGroups) {
    const list = res.styles[g.id];
    if (!list) continue;
    for (const s of list.slice(0, 2)) if (s.score > 1.2) styleHints.push(s.tag);
  }
  return { content: content.join(', '), artists: res.artists, styleHints };
}

const QUALITY_DEFAULT = 'masterpiece, best quality, very aesthetic, absurdres';
const tok = (t, w) => (Math.abs(w - 1) < 1e-6 ? t : `${fmtWeight(w)}::${t}::`);
const pickRand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (x) => Math.round(x * 20) / 20;

function specToCand(spec, id, round, rationale) {
  const style = join(
    spec.artists.map((a) => tok(`artist:${a.tag}`, a.w)).join(', '),
    spec.tags.map((t) => tok(t.tag, t.w)).join(', '),
    spec.extra,
  );
  return {
    id, round, rationale, spec: JSON.parse(JSON.stringify(spec)),
    style_prompt: style, negative_prompt: spec.negative,
    scale: spec.scale, cfg_rescale: spec.cfg_rescale, steps: spec.steps, sampler: spec.sampler,
    images: [], claude: null, note: '',
  };
}

const specKey = (s) => JSON.stringify([s.artists.map((a) => [a.tag, a.w]).sort(), s.tags.map((t) => [t.tag, t.w]).sort(), s.extra, s.negative, s.scale, s.cfg_rescale, s.steps, s.sampler]);

async function clipAnalyze(run) {
  run.status = 'analyzing';
  log('예시 이미지 분석 중 (CLIP)…');
  const bmp = await createImageBitmap(run.refBlob);
  [run.width, run.height] = sizeFor(bmp.width, bmp.height);
  run.refVec = await embedStyle(run.refBlob);
  const ref = await analyzeReference(run.refBlob);
  if (!run.content) run.content = ref.content;
  run.artistPool = ref.artists.slice(0, 40).map((a) => a.tag);
  run.styleHints = ref.styleHints;
  run.analysis = `CLIP 추정 — 비슷한 작가: ${run.artistPool.slice(0, 8).join(', ')} … / 두드러진 화풍: ${ref.styleHints.join(', ') || '없음'}`;

  // 출발 스펙
  if (run.mode === 'current') {
    const { mix, rest } = extractArtists(run.startPos || '');
    const st = run.startSettings || {};
    run.base = {
      artists: mix.map((a) => ({ tag: a.tag, w: a.weight })), tags: [], extra: rest || QUALITY_DEFAULT,
      negative: run.startNeg || DEFAULT_NEG,
      scale: clamp(st.scale, 1, 10, 5), cfg_rescale: clamp(st.cfgRescale, 0, 1, 0), steps: Math.round(clamp(st.steps, 10, 28, 28)),
      sampler: SAMPLERS.includes(st.sampler) ? st.sampler : 'k_euler_ancestral',
    };
  } else {
    run.base = { artists: [], tags: [], extra: QUALITY_DEFAULT, negative: DEFAULT_NEG, scale: 5, cfg_rescale: 0, steps: 28, sampler: 'k_euler_ancestral' };
  }
  run.seen = new Set();
  run.screened = []; // 작가 단독 점수 [{ tag, clip }]
  const reserve = run.budget >= 30 ? Math.min(6, Math.floor(run.budget * 0.1)) : 0;
  const avail = run.budget - reserve;
  run.plan = {
    reserve,
    screen: Math.max(run.batch, Math.round(avail * 0.3)),
    mix: Math.round(avail * 0.35),
    tags: Math.round(avail * 0.15),
  };
  run.round = 0;
  log(`분석 완료 · 내용 프롬프트: ${run.content}`, 'good');
}

function bestSpec(run) {
  const top = leaderboard(run, 1)[0];
  return top?.c.spec ? JSON.parse(JSON.stringify(top.c.spec)) : JSON.parse(JSON.stringify(run.base));
}

// 현재 단계에 맞는 후보 k개 만들기
function nextBatch(run, k) {
  const used = run.used;
  const { screen, mix, tags } = run.plan;
  const out = [];
  const push = (spec, why) => {
    const key = specKey(spec);
    if (run.seen.has(key) || out.length >= k) return;
    run.seen.add(key);
    out.push({ spec, why });
  };
  const base = run.base;

  if (used < screen) {
    run.phase = '① 작가 단독 시험';
    if (!run.cands.length && base.artists.length) push(JSON.parse(JSON.stringify(base)), '출발점 (지금 프롬프트)');
    const tried = new Set(run.screened.map((s) => s.tag));
    for (const tag of run.artistPool) {
      if (out.length >= k) break;
      if (tried.has(tag)) continue;
      push({ ...JSON.parse(JSON.stringify(base)), artists: [{ tag, w: 1 }] }, `작가 단독: ${tag}`);
    }
    if (out.length) return out;
  }
  const topArtists = run.screened.slice().sort((a, b) => b.clip - a.clip).slice(0, 6).map((s) => s.tag);
  if (used < screen + mix && topArtists.length) {
    run.phase = '② 작가 조합·가중치';
    const best = bestSpec(run);
    let guard = 0;
    while (out.length < k && guard++ < 200) {
      const r = Math.random();
      if (r < 0.4 || best.artists.length < 2) {
        // 새 조합: 상위 작가 2~4명, 가중치 0.4~1.2
        const n = 2 + Math.floor(Math.random() * 3);
        const pool = topArtists.slice();
        const artists = [];
        while (artists.length < n && pool.length) {
          const t = pool.splice(Math.floor(Math.random() * Math.min(pool.length, 4)), 1)[0];
          artists.push({ tag: t, w: round2(0.4 + Math.random() * 0.8) });
        }
        push({ ...best, artists }, `새 조합 ${artists.map((a) => a.tag).join(' + ')}`);
      } else {
        // 최고 후보 변형: 가중치 조정 / 한 명 빼기 / 한 명 추가
        const s = JSON.parse(JSON.stringify(best));
        const m = Math.random();
        if (m < 0.55) {
          const a = pickRand(s.artists);
          a.w = round2(clamp(a.w + pickRand([-0.3, -0.2, -0.1, 0.1, 0.2, 0.3]), 0.2, 1.5, 1));
          push(s, `가중치 조정 ${a.tag} → ${a.w}`);
        } else if (m < 0.75 && s.artists.length > 1) {
          const i = Math.floor(Math.random() * s.artists.length);
          const [gone] = s.artists.splice(i, 1);
          push(s, `빼보기 ${gone.tag}`);
        } else {
          const cand = topArtists.filter((t) => !s.artists.some((a) => a.tag === t));
          if (cand.length && s.artists.length < 5) {
            const t = pickRand(cand);
            s.artists.push({ tag: t, w: round2(0.3 + Math.random() * 0.5) });
            push(s, `더해보기 ${t}`);
          }
        }
      }
    }
    return out;
  }
  if (used < screen + mix + tags) {
    run.phase = '③ 화풍 태그';
    const best = bestSpec(run);
    const hints = [...(run.styleHints || []), 'high complexity', 'ultra complexity', 'depthness', 'meta:golden era'];
    for (const tag of hints) {
      if (best.tags.some((t) => t.tag === tag) || best.extra.includes(tag)) continue;
      push({ ...best, tags: [...best.tags, { tag, w: 1 }] }, `태그 더하기: ${tag}`);
      push({ ...best, tags: [...best.tags, { tag, w: 1.3 }] }, `태그 강하게: ${tag}`);
    }
    for (const t of best.tags) push({ ...best, tags: best.tags.filter((x) => x !== t) }, `태그 빼기: ${t.tag}`);
    if (out.length) return out.slice(0, k);
  }
  run.phase = '④ 설정·부정 프롬프트';
  const best = bestSpec(run);
  const variants = [
    { scale: round2(best.scale - 1) }, { scale: round2(best.scale + 1) }, { scale: round2(best.scale - 0.5) }, { scale: round2(best.scale + 0.5) },
    { cfg_rescale: 0 }, { cfg_rescale: 0.2 }, { cfg_rescale: 0.4 },
    { steps: best.steps === 28 ? 23 : 28 },
    { sampler: 'k_euler_ancestral' }, { sampler: 'k_dpmpp_2m_sde' }, { sampler: 'k_euler' }, { sampler: 'k_dpmpp_2s_ancestral' },
    { negative: DEFAULT_NEG }, { negative: run.startNeg || DEFAULT_NEG }, { negative: join(best.negative, 'monochrome, greyscale, sketch') },
  ];
  for (const v of variants.sort(() => Math.random() - 0.5)) {
    const s = { ...best, ...v };
    s.scale = clamp(s.scale, 2, 9, 5);
    push(s, '설정 ' + Object.entries(v).map(([a, b]) => `${a}=${typeof b === 'string' && b.length > 20 ? b.slice(0, 20) + '…' : b}`).join(', '));
  }
  return out;
}

async function clipLoop(run) {
  const seed = run.seeds[0];
  while (!run.stopping) {
    const left = run.budget - run.plan.reserve - run.used;
    if (left <= 0) break;
    let cands = run.pending;
    if (!cands.length) {
      run.round++;
      cands = nextBatch(run, Math.min(run.batch, left)).map((b, i) => specToCand(b.spec, `r${run.round}c${i + 1}`, run.round, `${run.phase} · ${b.why}`));
      if (!cands.length) { log('더 시험할 후보가 없어요'); break; }
    }
    run.pending = [];
    run.cands.push(...cands);
    run.status = 'generating';
    emitT();
    await renderCands(run, cands, () => seed);
    // 작가 단독 결과 기록
    for (const c of cands) if (c.images.length && c.spec.artists.length === 1 && c.rationale.includes('작가 단독')) run.screened.push({ tag: c.spec.artists[0].tag, clip: c.images[0].clip });
    if (run.stopping) {
      const undone = cands.filter((c) => !c.images.length);
      run.cands = run.cands.filter((c) => !undone.includes(c));
      for (const c of undone) run.seen.delete(specKey(c.spec));
      run.pending = undone;
      break;
    }
    const top = leaderboard(run, 1)[0];
    run.rounds.push({ round: run.round, critique: `${run.phase} — 이번 라운드 최고 CLIP ${Math.max(...cands.filter((c) => c.images.length).map((c) => c.images[0].clip)).toFixed(3)}` });
    log(`라운드 ${run.round} (${run.phase}) 끝 · 현재 1위 ${top?.c.id} CLIP ${top?.s.clip?.toFixed(3)}`, 'good');
    if (run.humanPick && run.budget - run.plan.reserve - run.used > 0) {
      run.status = 'picking';
      run.waitingPick = true;
      log('👍 마음에 드는 이미지를 고르고 "다음 라운드"를 눌러주세요');
      emitT();
      await new Promise((res) => { run.pickResolve = res; });
      run.pickResolve = null;
      run.waitingPick = false;
    }
  }
}

// 사람이 고른 후보 표시 (👍 토글)
export function togglePick(run, candId) {
  const c = run.cands.find((x) => x.id === candId);
  if (!c) return;
  c.picked = !c.picked;
  emitT();
}
export function resolvePick(run) { if (run.pickResolve) run.pickResolve(); }

async function clipFinish(run) {
  const board = leaderboard(run, 3);
  if (!board.length) return;
  const left = run.budget - run.used;
  if (left >= 2 && board.length >= 2) {
    run.status = 'validating';
    run.phase = '⑤ 새 시드로 검증';
    log(`검증: 상위 ${board.length}개 후보를 새 시드로 다시 생성`);
    const vc = [];
    for (const seed of run.seeds.slice(1).concat([randSeed()])) for (const { c } of board) vc.push({ c, seed });
    for (const { c, seed } of vc.slice(0, left)) {
      if (run.stopping) break;
      await renderCands(run, [c], () => seed);
    }
  }
  if (run.stopping) return;
  // 여러 시드 평균이 가장 높은 후보 (👍 우선)
  const ranked = leaderboard(run, 3);
  const win = ranked[0].c;
  run.final = { ...win, id: 'final', winner: win.id };
  const sp = win.spec;
  run.final.summary = [
    `우승 ${win.id} (CLIP 평균 ${ranked[0].s.clip.toFixed(3)}, ${win.images.length}장 기준${win.picked ? ', 👍 선택' : ''})`,
    `작가: ${sp.artists.map((a) => `${a.tag}${a.w !== 1 ? ' ×' + a.w : ''}`).join(', ') || '없음'}`,
    sp.tags.length ? `더한 화풍 태그: ${sp.tags.map((t) => t.tag).join(', ')}` : null,
    `설정: CFG ${sp.scale} · Rescale ${sp.cfg_rescale} · ${sp.steps}스텝 · ${sp.sampler}`,
    'CLIP은 그림체를 숫자로만 비교해서, 눈매나 선 굵기 같은 세부는 놓칠 수 있어요. 결과를 보고 👍 고르기나 비교 실험으로 다듬어 보세요.',
  ].filter(Boolean).join('\n');
  run.status = 'done';
  log(`완료! 우승 ${win.id} · 생성 ${run.used}장`, 'good');
  const saved = JSON.parse(localStorage.getItem('gk.tunerResults') || '[]');
  saved.unshift({ time: Date.now(), runId: run.id, brain: 'clip', style_prompt: win.style_prompt, negative_prompt: win.negative_prompt, scale: win.scale, cfg_rescale: win.cfg_rescale, steps: win.steps, sampler: win.sampler, lockedPos: run.lockedPos, lockedNeg: run.lockedNeg, model: run.model });
  localStorage.setItem('gk.tunerResults', JSON.stringify(saved.slice(0, 30)));
}
