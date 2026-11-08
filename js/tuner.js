// 자동 그림체 튜너 엔진
// 예시 이미지 → (Claude 분석 + CLIP 후보) → [K장 생성 → CLIP 점수 → Claude 평가·다음 후보] 반복 → 최종 프롬프트·네거티브·설정
import { state, emit, NEG_BLOCKS } from './state.js';
import { fmtWeight } from './prompt.js';
import { MODELS, SAMPLERS, stepRange, clampSteps } from './nai.js';
import { imageStats, statSim, describeStats } from './imgstats.js';
import { splitPrompt, hasTag } from './tagtext.js';
import { loadArtists } from './artists.js';
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
- Settings: scale (CFG) 3-7 typical, cfg_rescale 0-0.5, steps: V5 models 22-25, V4.5 models 25-28 (the program clamps to this range), sampler from the allowed list.
- The main style prompt should be complete like a pro user's: weighted artists, several style tags (coloring, contrast, line, rendering, era such as "year 2024", V5 complexity), optional negative-weighted opposites (e.g. "-1.5::flat color::"), then quality tags. The negative prompt should be thorough (quality junk, anatomy, eyes, unwanted color/style blocks), typically 60-120 tags. Lower CFG = softer/more painterly, higher = crisper/more saturated; rescale tames oversaturation at high CFG.

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
  steps: { type: 'integer', description: 'V5: 22-25, V4.5: 25-28' },
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

function normalizeCand(c, id, round, model) {
  return {
    id, round,
    rationale: c.rationale || '',
    style_prompt: (c.style_prompt || '').trim(),
    negative_prompt: (c.negative_prompt || '').trim(),
    scale: clamp(c.scale, 1, 10, 5),
    cfg_rescale: clamp(c.cfg_rescale, 0, 1, 0),
    steps: clampSteps(model, c.steps),
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

// 닮음(match, 0~1) = CLIP 그림체 유사도 60% + 색감·명암·선 통계 40% (둘 다 이번 실행 안에서 0~1로 맞춤)
// 종합 점수
//  - Claude 두뇌: Claude 점수(0~10) 70% + 닮음 30%
//  - CLIP 두뇌: 닮음 + 내가 👍한 후보 보너스 1
export function scoreOf(run, cand) {
  const imgs = run.cands.flatMap((c) => c.images);
  const range = (k) => { const xs = imgs.map((i) => i[k]).filter((x) => x != null); return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 0]; };
  const avg = (k) => { const xs = cand.images.map((i) => i[k]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const n01 = (v, [lo, hi]) => (v == null || hi <= lo ? 0.5 : (v - lo) / (hi - lo));
  const clip = avg('clip'), stat = avg('stat');
  const match = 0.6 * n01(clip, range('clip')) + 0.4 * n01(stat, range('stat'));
  // 👍 보너스: 나중 라운드에서 고른 것일수록 조금 더 (앞선 👍를 다듬은 결과라서)
  if (run.brain === 'clip') return { total: match + (cand.picked ? 1 + 0.03 * cand.round : 0), clip, stat, match };
  const cl = cand.claude == null ? null : cand.claude / 10;
  return { total: cl == null ? match * 0.3 : cl * 0.7 + match * 0.3, clip, stat, match };
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
    startSettings: opts.startSettings || null,
    pickedArtists: opts.pickedArtists || [], // 샘플 보고 내가 고른 작가 // CLIP 두뇌 + 현재 프롬프트 출발일 때 설정
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
  run.refStats = await imageStats(run.refBlob);
  const groups = await loadStyleGroups();
  const res = await analyzeImage(run.refBlob, { exclude: state.hidden, groups });
  const top = res.artists.slice(0, 40);
  const best = top[0]?.sim || 1;
  run.clipHints = 'CLIP artist candidates (similarity of each artist\'s NovelAI V5 sample render to the reference, 100 = best match):\n'
    + top.map((a) => `artist:${a.tag} (${Math.round((a.sim / best) * 100)})`).join(', ')
    + '\n\nCLIP style-tag hints (z-score within group, higher = more prominent):\n'
    + Object.entries(res.styles).map(([g, list]) => `${g}: ` + list.slice(0, 5).map((s) => `${s.tag} (${s.score.toFixed(1)})`).join(', ')).join('\n')
    + `\n\nMeasured color/line stats of the reference: ${describeStats(run.refStats).join(', ') || 'average'} (mean saturation ${run.refStats.meanS.toFixed(2)}, value contrast ${run.refStats.stdV.toFixed(2)}, edge density ${run.refStats.edgeD.toFixed(2)})`
    + (run.pickedArtists.length ? `\n\nThe USER looked at sample renders and picked these artists as closest to the reference — build combinations mainly from them: ${run.pickedArtists.map((t) => 'artist:' + t).join(', ')}` : '')
    + `\nAlways combine 2-4 artists (more artists tends to look worse), weights 0.3-1.0; never test a single artist alone. On V5 models never use any weight above 1.0 (it becomes too strong); on V4.5 keep weights within 1.3.`
    + `\nA thorough negative prompt to start from (adapt it):\n${Object.values(NEG_BLOCKS).join(', ')}`;
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
  run.pending = data.candidates.slice(0, k).map((c, i) => normalizeCand(c, `r1c${i + 1}`, 1, run.model));
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
    const stat = statSim(run.refStats, await imageStats(item.blob));
    c.images.push({ itemId: item.id, seed, clip, stat, blob: item.blob, url: URL.createObjectURL(item.blob) });
    log(`${c.id} 생성 (${run.used}/${run.budget}) · CLIP ${clip.toFixed(3)} · 색감 ${stat.toFixed(3)}`);
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
  run.pending = data.candidates.slice(0, k).map((c, i) => normalizeCand(c, `r${run.round}c${i + 1}`, run.round, run.model));
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
    run.pending = data.candidates.slice(0, k).map((c, i) => normalizeCand(c, `r${run.round}c${i + 1}`, run.round, run.model));
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
  run.final = normalizeCand(data, 'final', run.round, run.model);
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
// 점수 = CLIP 그림체 유사도 60% + 색감·명암·선 통계 40% (+ 내가 👍한 후보 보너스). 모든 라운드가 같은 시드라 서로 비교 가능.
// 단계: ① 작가 단독 시험 → ② 작가 조합·가중치 → ③ 화풍 태그 → ④ 설정·부정 프롬프트 → ⑤ 새 시드로 검증

let contentGroupsPromise;
const loadContentGroups = () => (contentGroupsPromise ||= fetch(new URL('../assets/content-tags.json', import.meta.url)).then((r) => r.json()).then((j) => j.groups));

// 예시 이미지 분석 (시작 전에 미리 볼 수 있게 export): 내용 프롬프트 추정 + 작가 후보 + 화풍 힌트 + 색감 통계
export async function analyzeReference(blob) {
  const [styleGroups, contentGroups] = await Promise.all([loadStyleGroups(), loadContentGroups()]);
  const [res, stats] = await Promise.all([
    analyzeImage(blob, { exclude: state.hidden, groups: [...styleGroups, ...contentGroups] }),
    imageStats(blob),
  ]);
  const content = [];
  for (const g of contentGroups) {
    const list = res.styles[g.id];
    if (!list?.length) continue;
    // CLIP 추정은 틀릴 수 있어서, 확실히 두드러질 때만 넣음 (틀린 태그보다 빠진 태그가 나음)
    const need = g.id === 'c_frame' ? 1.2 : ['c_clothes', 'c_bg'].includes(g.id) ? 2.1 : 1.6;
    for (const s of list.slice(0, g.pick)) if (s.score > need) content.push(s.tag);
  }
  const styleHints = [], hintDetail = [];
  for (const g of styleGroups) {
    const list = res.styles[g.id];
    if (!list) continue;
    for (const s of list.slice(0, 2)) {
      if (s.score <= 1.2 || NEVER_AUTO.has(s.tag)) continue;
      styleHints.push(s.tag);
      hintDetail.push({ tag: s.tag, group: g.id, score: s.score });
    }
  }
  return { content: content.join(', '), artists: res.artists, styleHints, hintDetail, stats, statWords: describeStats(stats) };
}

// CLIP이 자주 헛짚는 태그: 자동으로는 절대 안 넣음
const NEVER_AUTO = new Set(['ai-generated', 'abstract', 'color trace', 'calligraphy brush (medium)', 'unconventional media', 'mixed media', 'motion lines', 'motion blur', 'glitch', 'multiple views', 'photo (medium)', 'jpeg artifacts']);
// 처음부터 넣어도 되는 분류 (나머지 힌트는 ③ 단계에서 넣어보고 점수로 판단)
const START_GROUPS = new Set(['coloring', 'style']);

export const QUALITY_DEFAULT = 'masterpiece, best quality, very aesthetic, absurdres, detailed illustration, intricate details';
const QUALITY_SET = new Set(['masterpiece', 'best quality', 'very aesthetic', 'absurdres', 'highres', 'amazing quality', 'detailed illustration', 'intricate details', 'official art', 'high quality', 'great quality', 'good quality', 'aesthetic', 'very aesthetic']);
const tok = (t, w) => (Math.abs(w - 1) < 1e-6 ? t : `${fmtWeight(w)}::${t}::`);
const pickRand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (x) => Math.round(x * 20) / 20;
const nrm = (t) => t.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
const clone = (x) => JSON.parse(JSON.stringify(x));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function specText(spec) {
  return join(
    spec.artists.map((a) => tok(a.bare ? a.tag : `artist:${a.tag}`, a.w)).join(', '),
    spec.tags.map((t) => tok(t.tag, t.w)).join(', '),
    spec.extra,
    spec.quality,
  );
}

function specToCand(spec, id, round, rationale) {
  return {
    id, round, rationale, spec: clone(spec),
    style_prompt: specText(spec), negative_prompt: spec.negative,
    scale: spec.scale, cfg_rescale: spec.cfg_rescale, steps: spec.steps, sampler: spec.sampler,
    images: [], claude: null, note: '',
  };
}

const specKey = (s) => JSON.stringify([s.artists.map((a) => [a.tag, a.w]).sort(), s.tags.map((t) => [t.tag, t.w]).sort(), s.extra, s.quality, s.negative, s.scale, s.cfg_rescale, s.steps, s.sampler]);

// 예시 특징에 맞춘 넉넉한 부정 프롬프트
function buildNegative(stats, hints) {
  const b = NEG_BLOCKS;
  const has = (re) => hints.some((t) => re.test(t));
  const parts = [b.base, b.anatomy, b.eyes];
  if (stats.meanS > 0.25) parts.push(b.dull);
  if (stats.meanS > 0.1) parts.push(b.mono);
  if (!has(/realistic|3d|photo/)) parts.push(b.real);
  if (!has(/sketch|traditional|watercolor|painterly|pencil|oekaki/)) parts.push(b.rough);
  parts.push(b.chibi, b.old);
  return parts.join(', ');
}

// 예시 특징 → 처음 넣을 화풍 태그
function startStyleTags(run) {
  const st = run.refStats;
  const out = [];
  const add = (tag, w = 1) => { if (!out.some((t) => nrm(t.tag) === nrm(tag))) out.push({ tag, w }); };
  for (const d of (run.hintDetail || []).filter((x) => START_GROUPS.has(x.group) && x.score > 1.5).slice(0, 3)) add(d.tag);
  if (st.meanS > 0.42) add('vibrant colors');
  else if (st.meanS < 0.2 && st.meanS > 0.1) add('muted color');
  if (st.stdV > 0.29) add('high contrast');
  if (MODELS[run.model]?.v5) add('high complexity');
  add('year 2024');
  return out;
}

// 생성 페이지 프롬프트를 작가 / 화풍 태그 / 기타 / 퀄리티로 나누기
async function parseStart(run, text) {
  const known = new Set((await loadArtists()).map((a) => nrm(a.tag)));
  const styleSet = new Set((await loadStyleGroups()).flatMap((g) => g.tags.map(([t]) => nrm(t))));
  const spec = { artists: [], tags: [], extra: '', quality: '' };
  const extra = [], quality = [];
  for (const t of splitPrompt(text)) {
    const key = nrm(t.tag);
    if (run.lockedPos && hasTag(run.lockedPos, t.tag)) continue;
    if (t.artist) spec.artists.push({ tag: t.tag.replace(/^artist:\s*/i, ''), w: t.weight });
    else if (t.weight > 0 && known.has(key)) spec.artists.push({ tag: t.tag, w: t.weight, bare: true });
    else if (QUALITY_SET.has(key) && Math.abs(t.weight - 1) < 1e-6) quality.push(t.tag);
    else if (styleSet.has(key) || /^year \d{4}$|complexity$|^meta:/.test(key)) spec.tags.push({ tag: t.tag, w: t.weight });
    else extra.push(tok(t.tag, t.weight));
  }
  spec.extra = extra.join(', ');
  spec.quality = quality.join(', ') || QUALITY_DEFAULT;
  return spec;
}

async function clipAnalyze(run) {
  run.status = 'analyzing';
  log('예시 이미지 분석 중 (CLIP + 색감·선 통계)…');
  const bmp = await createImageBitmap(run.refBlob);
  [run.width, run.height] = sizeFor(bmp.width, bmp.height);
  run.refVec = await embedStyle(run.refBlob);
  const ref = await analyzeReference(run.refBlob);
  run.refStats = ref.stats;
  if (!run.content) run.content = ref.content;
  // 분석한 작가 상위 10명이 후보. 첫 조합 = 상위 5명, 가중치는 유사도에 비례 (0.4~1.0)
  const topA = ref.artists.slice(0, 10);
  run.artistPool = topA.map((a) => a.tag);
  const hiS = topA[0]?.sim || 1, loS = topA[2]?.sim ?? hiS;
  run.startCombo = topA.slice(0, 3).map((a) => ({ tag: a.tag, w: round2(hiS > loS ? 0.5 + (0.5 * (a.sim - loS)) / (hiS - loS) : 0.7) }));
  run.styleHints = ref.styleHints;
  run.hintDetail = ref.hintDetail;
  run.analysis = `비슷한 작가 (CLIP): ${run.artistPool.slice(0, 8).join(', ')} …\n두드러진 화풍 (CLIP): ${ref.styleHints.join(', ') || '없음'}\n색감·선: ${ref.statWords.join(', ') || '보통'} (채도 ${ref.stats.meanS.toFixed(2)} · 대비 ${ref.stats.stdV.toFixed(2)} · 윤곽 ${ref.stats.edgeD.toFixed(2)})`;

  const [lo, hi] = stepRange(run.model);
  const st = run.startSettings || {};
  const settings = run.mode === 'current'
    ? { scale: clamp(st.scale, 1, 10, 5), cfg_rescale: clamp(st.cfgRescale, 0, 1, 0), steps: clampSteps(run.model, st.steps), sampler: SAMPLERS.includes(st.sampler) ? st.sampler : 'k_euler_ancestral' }
    : { scale: 5, cfg_rescale: 0.1, steps: Math.round((lo + hi) / 2), sampler: 'k_euler_ancestral' };
  if (run.mode === 'current') {
    const parsed = await parseStart(run, run.startPos || '');
    run.base = { ...parsed, negative: run.startNeg || buildNegative(run.refStats, run.styleHints), ...settings };
    if (!parsed.tags.length) run.base.tags = startStyleTags(run);
  } else {
    run.base = { artists: [], tags: startStyleTags(run), extra: '', quality: QUALITY_DEFAULT, negative: buildNegative(run.refStats, run.styleHints), ...settings };
  }
  run.seen = new Set();
  const reserve = run.budget >= 30 ? Math.min(6, Math.floor(run.budget * 0.1)) : 0;
  const avail = run.budget - reserve;
  // 단계별 몫을 라운드(후보 수) 단위로 맞춤 → 작은 예산에서도 ①~④가 다 돌아감
  const rounds = (share) => Math.max(1, Math.round((avail * share) / run.batch)) * run.batch;
  run.plan = { reserve, screen: rounds(0.35), mix: rounds(0.3), tags: rounds(0.15) };
  run.round = 0;
  log(`분석 완료 · 내용 프롬프트: ${run.content || '(없음)'}`, 'good');
}

// 튜너가 쓰는 가중치 상한: V5는 1.0 넘으면 너무 세져서 1.0, V4.5는 1.3
const maxWeight = (run) => (MODELS[run.model]?.v5 ? 1 : 1.3);

function bestSpec(run) {
  const top = leaderboard(run, 1)[0];
  return clone(top?.c.spec || run.base);
}

// 현재 단계에 맞는 후보 k개 만들기
function nextBatch(run, k) {
  const used = run.used;
  const { screen, mix, tags } = run.plan;
  // 이번 단계 남은 몫만큼만 (다음 단계로 넘치지 않게)
  for (const end of [screen, screen + mix, screen + mix + tags]) if (used < end) { k = Math.min(k, end - used); break; }
  const out = [];
  const push = (spec, why) => {
    const key = specKey(spec);
    if (run.seen.has(key) || out.length >= k) return;
    run.seen.add(key);
    out.push({ spec, why });
  };
  const base = run.base;

  const pool = run.artistPool;
  const maxW = maxWeight(run);
  const MAX_ART = 4; // 작가가 많으면 안 예뻐질 가능성이 커서 4명까지
  const W = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].filter((w) => w <= maxW);
  // 작가 2~3명 조합 (앞쪽 = 더 비슷한 작가가 잘 뽑힘). 대표 작가 한 명은 0.7 이상
  const randomCombo = () => {
    const n = Math.min(pool.length, 2 + Math.floor(Math.random() * 2));
    const avail = pool.slice();
    const arts = [];
    while (arts.length < n && avail.length) {
      const t = avail.splice(Math.floor(Math.pow(Math.random(), 1.7) * avail.length), 1)[0];
      arts.push({ tag: t, w: pickRand(W) });
    }
    if (arts.length) arts[0].w = Math.max(arts[0].w, 0.7);
    return arts;
  };
  // 조합 하나를 조금만 바꾸기 (가중치 / 한 명 바꾸기 / 한 명 더하기 / 한 명 빼기). 4명 넘으면 빼기 우선, 2명 아래로는 안 뺌
  const mutate = (arts) => {
    const s = clone(arts).map((a) => ({ ...a, w: Math.min(a.w, maxW) }));
    const m = s.length > MAX_ART ? 0.95 : Math.random();
    const others = pool.filter((t) => !s.some((a) => nrm(a.tag) === nrm(t)));
    if (m < 0.45 || !others.length) {
      const a = pickRand(s);
      a.w = round2(clamp(a.w + pickRand([-0.2, -0.1, 0.1, 0.2]), 0.2, maxW, 0.6));
      return [s, `가중치 ${a.tag} → ${a.w}`];
    }
    if (m < 0.7) {
      const i = Math.floor(Math.random() * s.length);
      const t = pickRand(others);
      const gone = s[i].tag;
      s[i] = { tag: t, w: s[i].w };
      return [s, `바꾸기 ${gone} → ${t}`];
    }
    if (m < 0.85 && s.length < MAX_ART) {
      const t = pickRand(others);
      s.push({ tag: t, w: pickRand([0.3, 0.4, 0.5]) });
      return [s, `더하기 ${t}`];
    }
    if (s.length > 2) {
      const [gone] = s.splice(Math.floor(Math.random() * s.length), 1);
      return [s, `빼기 ${gone.tag}`];
    }
    const a = pickRand(s);
    a.w = round2(clamp(a.w + pickRand([-0.2, 0.2]), 0.2, maxW, 0.6));
    return [s, `가중치 ${a.tag} → ${a.w}`];
  };
  const comboName = (arts) => arts.map((a) => `${a.tag}${a.w !== 1 ? ' ' + a.w : ''}`).join(' + ');

  if (used < screen) {
    // 출발 조합(지금 프롬프트 작가 or 분석 상위 5명)을 그리고, 한 명씩 빼보고, 가중치 바꿔보고, 분석 작가로 바꿔보기
    run.phase = '① 조합 · 빼보기';
    const start = base.artists.length ? base.artists : run.startCombo || [];
    if (start.length) {
      push({ ...clone(base), artists: clone(start) }, base.artists.length ? '출발점 (지금 프롬프트 작가)' : `분석 상위 조합 ${comboName(start)}`);
      if (start.some((a) => a.w > maxW)) push({ ...clone(base), artists: start.map((a) => ({ ...a, w: Math.min(a.w, maxW) })) }, `작가 가중치 ${maxW} 넘는 것 낮추기`);
      if (start.length > 2) {
        for (const a of start) push({ ...clone(base), artists: clone(start.filter((x) => x !== a)) }, `빼보기 ${a.tag}`);
      }
    }
    let guard = 0;
    while (out.length < k && guard++ < 300) {
      if (start.length && Math.random() < 0.7) {
        const [arts, why] = mutate(start);
        push({ ...clone(base), artists: arts }, why);
      } else if (pool.length) {
        const arts = randomCombo();
        push({ ...clone(base), artists: arts }, `다른 조합 ${comboName(arts)}`);
      }
    }
    if (out.length) return out;
  }
  if (used < screen + mix && pool.length) {
    run.phase = '② 조합 다듬기';
    const top = leaderboard(run, 2).map(({ c }) => c.spec).filter(Boolean);
    const best = bestSpec(run);
    let guard = 0;
    while (out.length < k && guard++ < 300) {
      const r = Math.random();
      if (r < 0.2 && top.length === 2) {
        // 상위 두 조합 섞기
        const merged = [...top[0].artists];
        for (const a of top[1].artists) if (!merged.some((x) => nrm(x.tag) === nrm(a.tag))) merged.push(a);
        const arts = clone(shuffle(merged.slice(1)).slice(0, 1 + Math.floor(Math.random() * 2)));
        arts.unshift(clone(merged[0]));
        push({ ...best, artists: arts }, `1·2위 섞기 ${comboName(arts)}`);
      } else {
        const [arts, why] = mutate(best.artists.length ? best.artists : randomCombo());
        push({ ...best, artists: arts }, why);
      }
    }
    return out;
  }
  if (used < screen + mix + tags) {
    run.phase = '③ 화풍 태그';
    const best = bestSpec(run);
    const st = run.refStats;
    const inBest = (tag) => best.tags.some((t) => nrm(t.tag) === nrm(tag)) || hasTag(best.extra, tag);
    const ideas = [];
    const add = (tag, w, why) => { if (!inBest(tag)) ideas.push([{ ...best, tags: [...best.tags, { tag, w }] }, why]); };
    for (const tag of run.styleHints || []) add(tag, 1, `태그 더하기: ${tag}`);
    const extraIdeas = ['anime coloring', 'soft line', 'ligne claire', 'detailed hair', 'shiny skin', 'rim light', 'depthness', 'year 2025', 'year 2022'];
    if (MODELS[run.model]?.v5) extraIdeas.push('ultra complexity', 'meta:golden era');
    if (st.meanS > 0.35) { add('vibrant colors', Math.min(1.2, maxW), '선명한 색'); if (!inBest('flat color')) ideas.push([{ ...best, tags: [...best.tags, { tag: 'flat color', w: -1 }] }, '단색 채색 밀어내기 (-1)']); }
    if (st.meanS < 0.22) add('pastel colors', 1, '파스텔 색');
    if (st.stdV > 0.27) add('high contrast', Math.min(1.2, maxW), '대비');
    for (const tag of extraIdeas) add(tag, 1, `태그 더하기: ${tag}`);
    for (const t of best.tags) {
      ideas.push([{ ...best, tags: best.tags.filter((x) => x !== t) }, `태그 빼기: ${t.tag}`]);
      // 튜너가 올리는 강조는 1.3까지만 (원래 더 센 건 그대로 두고 약하게만 시험)
      if (t.w > 0 && t.w + 0.2 <= maxW + 1e-6) ideas.push([{ ...best, tags: best.tags.map((x) => (x === t ? { ...x, w: round2(x.w + 0.2) } : x)) }, `태그 조금 강하게: ${t.tag}`]);
      if (t.w > maxW) ideas.push([{ ...best, tags: best.tags.map((x) => (x === t ? { ...x, w: maxW } : x)) }, `강조 줄이기: ${t.tag} ${t.w} → ${maxW}`]);
    }
    // 상한 넘는 강조가 있으면 전부 낮춘 버전을 먼저 시험
    if (best.tags.some((t) => t.w > maxW)) push({ ...best, tags: best.tags.map((t) => ({ ...t, w: Math.min(t.w, maxW) })) }, `화풍 강조 전부 ${maxW}로 낮추기`);
    for (const [s, why] of shuffle(ideas)) push(s, why);
    if (out.length) return out.slice(0, k);
  }
  run.phase = '④ 설정·부정 프롬프트';
  const best = bestSpec(run);
  const [lo, hi] = stepRange(run.model);
  const variants = [
    { scale: round2(best.scale - 1) }, { scale: round2(best.scale + 1) }, { scale: round2(best.scale - 0.5) }, { scale: round2(best.scale + 0.5) },
    { cfg_rescale: 0 }, { cfg_rescale: 0.2 }, { cfg_rescale: 0.4 },
    { sampler: 'k_euler_ancestral' }, { sampler: 'k_dpmpp_2m_sde' }, { sampler: 'k_euler' }, { sampler: 'k_dpmpp_2s_ancestral' },
  ];
  for (let s = lo; s <= hi; s++) if (s !== best.steps) variants.push({ steps: s });
  // 부정 프롬프트 묶음 켜고 끄기
  for (const [key, block] of Object.entries(NEG_BLOCKS)) {
    if (key === 'base') continue;
    variants.push(best.negative.includes(block)
      ? { negative: best.negative.replace(block, '').replace(/,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '').trim(), _why: `부정에서 빼기: ${key}` }
      : { negative: join(best.negative, block), _why: `부정에 더하기: ${key}` });
  }
  for (const v of shuffle(variants)) {
    const { _why, ...vv } = v;
    const s = { ...best, ...vv };
    s.scale = clamp(s.scale, 2, 9, 5);
    s.steps = clampSteps(run.model, s.steps);
    push(s, _why || '설정 ' + Object.entries(vv).map(([a, b]) => `${a}=${b}`).join(', '));
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
    if (run.stopping) {
      const undone = cands.filter((c) => !c.images.length);
      run.cands = run.cands.filter((c) => !undone.includes(c));
      for (const c of undone) run.seen.delete(specKey(c.spec));
      run.pending = undone;
      break;
    }
    if (run.humanPick && run.budget - run.plan.reserve - run.used > 0) {
      run.status = 'picking';
      run.waitingPick = true;
      log('👍 예시에 가까운 이미지를 고르고 "다음 라운드"를 눌러주세요');
      emitT();
      await new Promise((res) => { run.pickResolve = res; });
      run.pickResolve = null;
      run.waitingPick = false;
    }
    const top = leaderboard(run, 1)[0];
    const bestNow = Math.max(...cands.filter((c) => c.images.length).map((c) => scoreOf(run, c).match));
    run.rounds.push({ round: run.round, critique: `${run.phase} — 이번 라운드 최고 닮음 ${Math.round(bestNow * 100)}` });
    log(`라운드 ${run.round} (${run.phase}) 끝 · 현재 1위 ${top?.c.id}`, 'good');
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
  // 우승은 검증한 후보(여러 시드 평균) 중에서만 — 1장만 운 좋게 잘 나온 후보가 이기지 않게
  const ranked = board.map(({ c }) => ({ c, s: scoreOf(run, c) })).sort((a, b) => b.s.total - a.s.total);
  const win = ranked[0].c;
  run.final = { ...win, id: 'final', winner: win.id };
  const sp = win.spec;
  run.final.summary = [
    `우승 ${win.id} · 닮음 ${Math.round(ranked[0].s.match * 100)} (${win.images.length}장 평균${win.picked ? ', 👍 선택' : ''})`,
    `작가: ${sp.artists.map((a) => `${a.tag}${a.w !== 1 ? ' ×' + a.w : ''}`).join(', ') || '없음'}`,
    sp.tags.length ? `화풍 태그: ${sp.tags.map((t) => tok(t.tag, t.w)).join(', ')}` : null,
    `설정: CFG ${sp.scale} · Rescale ${sp.cfg_rescale} · ${sp.steps}스텝 · ${sp.sampler}`,
  ].filter(Boolean).join('\n');
  run.status = 'done';
  log(`완료! 우승 ${win.id} · 생성 ${run.used}장`, 'good');
  const saved = JSON.parse(localStorage.getItem('gk.tunerResults') || '[]');
  saved.unshift({ time: Date.now(), runId: run.id, brain: 'clip', style_prompt: win.style_prompt, negative_prompt: win.negative_prompt, scale: win.scale, cfg_rescale: win.cfg_rescale, steps: win.steps, sampler: win.sampler, lockedPos: run.lockedPos, lockedNeg: run.lockedNeg, model: run.model });
  localStorage.setItem('gk.tunerResults', JSON.stringify(saved.slice(0, 30)));
}