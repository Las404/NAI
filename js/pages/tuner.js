// 자동 그림체 튜너 페이지 (왼쪽: 준비 · 오른쪽: 진행/결과)
import { $, h, toast, openLightbox, dropZone, pickFile } from '../ui.js';
import { state, save, on, emit } from '../state.js';
import { MODELS, stepRange } from '../nai.js';
import { token, local } from '../store.js';
import { usageStats } from '../usage.js';
import { claudeKey, CLAUDE_MODEL } from '../claude.js';
import { tuner, createRun, startRun, stopRun, continueRun, leaderboard, scoreOf, MAX_BUDGET, analyzeReference, togglePick, resolvePick } from '../tuner.js';
import { ensureAck } from '../queueui.js';
import { queue } from '../queue.js';
import { prepareAutosave } from '../autosave.js';
import { promptBlock } from '../tagtext.js';
import { loadTagger } from '../wdtagger.js';

// 다시 그려도 펼침 상태 유지
const openState = {};
function det(key, defOpen, summary, ...children) {
  const d = h('details', { class: 'panel', open: (openState[key] ?? defOpen) ? '' : null }, h('summary', {}, summary), ...children);
  d.addEventListener('toggle', () => { openState[key] = d.open; });
  return d;
}

let refBlob = null;
let refInfo = null; // analyzeReference 결과
let refUrl = '';
const opt = {
  brain: local.get('tunerBrain', 'clip'),
  humanPick: local.get('tunerHumanPick', true),
  mode: local.get('tunerMode', 'fresh'),
  budget: local.get('tunerBudget', 48),
  batch: local.get('tunerBatch', 6),
  lockedPos: local.get('tunerLockedPos', '-3::loli, child, chibi::'),
  lockedNeg: local.get('tunerLockedNeg', ''),
  content: '',
};
const BUDGETS = [24, 48, 80, 120, 200];
const joinP = (...p) => p.map((x) => (x || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');

function seg(name, items, onPick) {
  return h('div', { class: 'seg tu-seg', id: 'tuSeg-' + name }, items.map(([v, label]) =>
    h('button', { class: opt[name] === v ? 'on' : '', onclick: (e) => {
      opt[name] = v;
      e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      onPick?.(v);
    } }, label)));
}

export function mount(el) {
  el.append(
    h('div', { class: 'tu-layout' },
      h('div', { class: 'tu-left' },
        h('div', { class: 'panel tu-setup' },
          h('h3', {}, '🎛 자동 그림체 튜너'),
          h('p', { class: 'note' }, '예시 그림을 올리면 내 NAI로 여러 장 뽑아 비교하면서 ', h('b', {}, '메인 프롬프트 · 네거티브 · 설정'), '을 깎아요.'),
          h('div', { id: 'tuDrop', class: 'dropzone tu-drop', onclick: (e) => { if (e.target.tagName !== 'IMG') pickFile('image/*', setRef); } },
            h('div', { id: 'tuRef' }, h('div', { class: 'big-emoji' }, '🖼️'), h('div', {}, '예시 그림을 끌어다 놓거나 눌러서 고르기'), h('div', { class: 'note' }, 'Ctrl+V 붙여넣기도 돼요'))),
          h('div', { id: 'tuRefInfo', class: 'tu-refinfo' }),
          h('div', { class: 'tu-field' }, h('div', { class: 'tu-label' }, '출발점'),
            seg('mode', [['fresh', '처음부터 새로'], ['current', '지금 프롬프트 다듬기']], (v) => local.set('tunerMode', v))),
          h('div', { class: 'tu-field' }, h('div', { class: 'tu-label' }, '생성 장수'),
            seg('budget', BUDGETS.map((n) => [n, n + '장']), (v) => { local.set('tunerBudget', v); estimate(); })),
          h('label', { class: 'inline tu-check' },
            h('input', { type: 'checkbox', checked: opt.humanPick, onchange: (e) => { opt.humanPick = e.target.checked; local.set('tunerHumanPick', opt.humanPick); estimate(); } }),
            h('span', {}, h('b', {}, '👍 라운드마다 내가 고르기'), h('span', { class: 'note' }, ' — 켜면 훨씬 잘 맞아요'))),
          h('div', { id: 'tuEst', class: 'note' }),
          h('div', { id: 'tuWarn' }),
          h('div', { class: 'row-gap' },
            h('button', { id: 'tuStart', class: 'primary grow tu-go', onclick: start }, '▶ 튜닝 시작'),
            h('button', { id: 'tuStop', class: 'danger', onclick: stopRun }, '■ 정지')),
          h('div', { id: 'tuMore' })),
        h('details', { class: 'panel tu-adv' },
          h('summary', {}, '⚙ 고급 설정'),
          h('label', {}, '비교용 내용 프롬프트 ', h('span', { class: 'note' }, '(예시를 올리면 자동으로 채워져요)'),
            h('textarea', { id: 'tuContent', rows: 3, placeholder: '1girl, solo, upper body, ... — 모든 후보가 같은 내용을 그려야 그림체만 공정하게 비교돼요', oninput: (e) => { opt.content = e.target.value; } })),
          h('label', {}, '라운드당 후보 ', h('b', { id: 'tuBatchV' }, opt.batch), '개',
            h('input', { type: 'range', min: 4, max: 12, step: 1, value: opt.batch, oninput: (e) => { opt.batch = Number(e.target.value); local.set('tunerBatch', opt.batch); $('tuBatchV').textContent = opt.batch; estimate(); } })),
          h('label', {}, '항상 넣을 태그 (메인)', h('textarea', { rows: 2, value: opt.lockedPos, oninput: (e) => { opt.lockedPos = e.target.value; local.set('tunerLockedPos', opt.lockedPos); } })),
          h('label', {}, '항상 넣을 태그 (네거티브)', h('textarea', { rows: 2, value: opt.lockedNeg, placeholder: '예: nsfw', oninput: (e) => { opt.lockedNeg = e.target.value; local.set('tunerLockedNeg', opt.lockedNeg); } })),
          h('div', { class: 'tu-label' }, '비교하는 두뇌'),
          seg('brain', [['clip', '무료 · CLIP'], ['claude', '유료 · Claude API']], (v) => { local.set('tunerBrain', v); status(); estimate(); }),
          h('div', { class: 'row-gap tight', id: 'tuKeyRow', style: { marginTop: '6px' } }, h('span', { id: 'tuKey', class: 'note' }), h('span', { class: 'grow' }), h('button', { class: 'small', onclick: openKey }, '🔑 Claude 키'))),
      ),
      h('div', { class: 'tu-right', id: 'tuRight' })),
  );
  dropZone($('tuDrop'), setRef);
  window.addEventListener('paste', (e) => {
    if (!location.hash.startsWith('#/tuner')) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) setRef(f);
  });
  on('tuner', render);
  on('usage', status);
  on('settings', estimate);
  render();
}

export function show() { status(); estimate(); render(); }

async function setRef(file) {
  refBlob = file;
  refInfo = null;
  const url = refUrl = URL.createObjectURL(file);
  $('tuRef').replaceChildren(h('img', { src: url, class: 'tu-ref', onclick: () => openLightbox(url, '예시 이미지') }), h('div', { class: 'note' }, '다른 그림으로 바꾸려면 빈 곳을 누르거나 끌어다 놓기'));
  const info = $('tuRefInfo');
  const msg = h('span', {}, ' 예시 분석 중…');
  info.replaceChildren(h('div', { class: 'note' }, h('span', { class: 'spinner tiny-spin' }), msg));
  loadTagger((m) => { msg.textContent = ' ' + m; }).catch(() => {});
  try {
    const r = await analyzeReference(file, (m) => { msg.textContent = ' ' + m; });
    if (refBlob !== file) return;
    refInfo = r;
    opt.content = r.content;
    $('tuContent').value = r.content;
    info.replaceChildren(
      row('비슷한 작가', r.artists.slice(0, 6).map((a) => a.tag).join(', ')),
      row(r.source === 'wd' ? '화풍 태그' : '화풍 (CLIP)', [...r.styleHints, ...r.statWords].join(', ') || '보통'),
      row('내용', r.content || '(못 찾음 — 고급 설정에서 적어 주세요)'));
  } catch (e) {
    info.replaceChildren(h('div', { class: 'bad' }, '분석 실패: ' + e.message));
  }
}
const row = (k, v) => h('div', { class: 'tu-kv' }, h('span', {}, k), h('span', {}, v));

async function status() {
  if (!$('tuKey')) return;
  $('tuKeyRow').hidden = opt.brain !== 'claude';
  $('tuKey').textContent = claudeKey.get() ? `✓ Claude 키 있음 (${CLAUDE_MODEL})` : 'Claude 키 없음';
  $('tuKey').className = 'note ' + (claudeKey.get() ? 'good-text' : 'bad');
  $('tuWarn').replaceChildren(...[
    !token.get() ? h('div', { class: 'bad note' }, '⚠ NAI 토큰이 없어요 (오른쪽 위 🔑)') : null,
    opt.brain === 'claude' && !claudeKey.get() ? h('div', { class: 'bad note' }, '⚠ Claude 모드는 Anthropic API 키가 필요해요 (고급 설정)') : null,
  ].filter(Boolean));
}

function estimate() {
  if (!$('tuEst')) return;
  const st = usageStats();
  const rounds = Math.ceil(opt.budget / opt.batch) + 1;
  const model = runModel();
  const [lo, hi] = stepRange(model);
  const battery = st.avgPercent ? ` · V5 배터리 약 ${(st.avgPercent * opt.budget).toFixed(0)}%` : '';
  const cost = opt.brain === 'claude' ? ` · Claude 비용 대략 $${(rounds * 0.12).toFixed(1)}~${(rounds * 0.25).toFixed(1)}` : ' · 추가 비용 없음';
  $('tuEst').textContent = `${MODELS[model]?.label} · 스텝 ${lo}~${hi} · 라운드 약 ${rounds}번${opt.humanPick ? ' (라운드마다 멈춤)' : ''}${battery}${cost}`;
}
const runModel = () => (MODELS[state.settings.model]?.medium ? 'nai-diffusion-5-full' : state.settings.model);

function openKey() {
  const input = h('input', { type: 'password', placeholder: 'sk-ant-...', value: claudeKey.get(), style: { width: '100%' } });
  const rem = h('input', { type: 'checkbox', checked: claudeKey.remembered() });
  const dlg = h('dialog', {},
    h('h3', {}, 'Anthropic API 키'),
    h('p', { class: 'note' }, 'console.anthropic.com → API Keys에서 만들 수 있어요. 키는 이 브라우저에만 저장되고 Anthropic API(api.anthropic.com)로만 보내요. ',
      '튜너가 이미지를 비교할 때마다 이 키로 요금이 나가요.'),
    input,
    h('label', { class: 'inline', style: { marginTop: '8px' } }, rem, '이 기기에 기억하기'),
    h('div', { class: 'row-gap end' },
      h('button', { class: 'ghost danger', onclick: () => { claudeKey.set('', false); dlg.close(); status(); } }, '지우기'),
      h('button', { class: 'ghost', onclick: () => dlg.close() }, '취소'),
      h('button', { class: 'primary', onclick: () => { claudeKey.set(input.value.trim(), rem.checked); dlg.close(); status(); } }, '저장')));
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  document.body.append(dlg);
  dlg.showModal();
}

async function start() {
  if (tuner.running) return;
  if (state.busy || queue.running) return toast('다른 생성이 진행 중이에요');
  if (!refBlob) return toast('예시 이미지를 먼저 올려주세요');
  if (!token.get()) { emit('needToken'); return; }
  if (opt.brain === 'claude' && !claudeKey.get()) return openKey();
  await prepareAutosave();
  if (!(await ensureAck())) return;
  const s = state.settings;
  const model = runModel();
  const [lo, hi] = stepRange(model);
  const msg = `${opt.mode === 'current' ? '지금 작가 조합에서 출발해 ' : '분석한 작가 상위 5명 조합에서 출발해 '}${opt.budget}장까지 ${queue.delay}초 간격으로 자동 생성하며 비교해요${opt.humanPick ? ' (라운드마다 멈추고 👍 고르기)' : ''}.\n모델 ${MODELS[model]?.label} · 스텝 ${lo}~${hi} · 크기는 예시 비율에 맞춰 무료 조건 안에서 골라요.\n언제든 ■ 정지할 수 있어요. 시작할까요?`;
  if (!confirm(msg)) return;
  const run = createRun({
    refBlob, mode: opt.mode,
    startPos: opt.mode === 'current' ? currentMainPrompt() : '',
    startNeg: opt.mode === 'current' ? s.negative : '',
    lockedPos: opt.lockedPos, lockedNeg: opt.lockedNeg,
    budget: opt.budget, batch: opt.batch, model: s.model, content: ($('tuContent').value || '').trim(),
    brain: opt.brain, humanPick: opt.humanPick,
    startSettings: { scale: s.scale, cfgRescale: s.cfgRescale, steps: s.steps, sampler: s.sampler },
  });
  startRun(run);
}

// 생성 페이지 상태를 하나의 메인 프롬프트 문자열로 (작가 믹스 + 메인)
function currentMainPrompt() {
  const parts = [];
  for (const a of state.mix) if (a.enabled !== false) parts.push(Math.abs(a.weight - 1) < 1e-6 ? `artist:${a.tag}` : `${a.weight}::artist:${a.tag}::`);
  if (state.settings.base) parts.push(state.settings.base);
  return parts.join(', ');
}

function applyCand(c, run) {
  if (!confirm('생성 페이지의 메인·네거티브 프롬프트와 설정을 이 결과로 바꿀까요?\n(작가 믹스 칸은 비우고 결과 프롬프트에 모두 들어가요. 인물은 캐릭터 프롬프트 칸에 쓰면 돼요.)')) return;
  state.mix = [];
  Object.assign(state.settings, {
    base: joinP(c.style_prompt, run.lockedPos) + ', ',
    negative: joinP(c.negative_prompt, run.lockedNeg),
    quality: false, styleTags: [],
    scale: c.scale, cfgRescale: c.cfg_rescale, steps: c.steps, sampler: c.sampler, model: run.model,
  });
  save.mix(); save.settings();
  toast('생성 페이지에 적용했어요', 'good');
}

function copyCand(c, run) {
  navigator.clipboard.writeText(`[메인]\n${joinP(c.style_prompt, run.lockedPos)}\n\n[네거티브]\n${joinP(c.negative_prompt, run.lockedNeg)}\n\n[설정] CFG ${c.scale} · Rescale ${c.cfg_rescale} · 스텝 ${c.steps} · ${c.sampler}`);
  toast('복사했어요');
}

const STATUS = { idle: '대기', analyzing: '🔍 예시 분석 중', generating: '🎨 생성 중', judging: '🧠 Claude 평가 중', validating: '✅ 새 시드로 검증 중', picking: '👍 골라주세요', done: '🎉 완료', stopped: '⏸ 멈춤', error: '❌ 오류' };
const pctOf = (run, c) => Math.round(scoreOf(run, c).match * 100);

// 라운드가 끝나고 내가 고르는 화면
function pickPanel(run) {
  const cs = run.cands.filter((c) => c.round === run.round && c.images.length);
  const n = cs.filter((c) => c.picked).length;
  return h('div', { class: 'panel tu-pick' },
    h('div', { class: 'row-gap tight' },
      h('h3', {}, `👍 라운드 ${run.round} — 예시와 그림체가 비슷한 걸 눌러주세요`),
      h('span', { class: 'grow' }),
      h('button', { class: 'primary', onclick: () => resolvePick(run) }, n ? `${n}개 골랐어요 · 다음 ▶` : '안 고르고 다음 ▶')),
    h('p', { class: 'note' }, `${run.phase || ''} · 고른 후보가 다음 라운드의 중심이 돼요. 여러 개 골라도 되고, 없으면 그냥 넘어가요.`),
    h('div', { class: 'tu-pickgrid' },
      h('figure', { class: 'ref' }, h('img', { src: run.refUrl, onclick: () => openLightbox(run.refUrl, '예시') }), h('figcaption', {}, h('b', {}, '예시'))),
      cs.map((c) => h('figure', { class: c.picked ? 'on' : '', onclick: () => togglePick(run, c.id) },
        h('img', { src: c.images[0].url, title: '눌러서 👍' }),
        c.picked ? h('div', { class: 'tu-badge' }, '👍') : null,
        h('figcaption', {}, h('span', { class: 'tu-score' }, `닮음 ${pctOf(run, c)}`), ' ', h('span', { class: 'note' }, c.rationale.split(' · ').pop()))))));
}

function render() {
  const box = $('tuRight');
  if (!box) return;
  const run = tuner.run;
  $('tuStart').disabled = tuner.running;
  $('tuStop').disabled = !tuner.running;
  $('tuMore').replaceChildren(run && !tuner.running && run.cands.length
    ? h('div', { class: 'row-gap' }, h('span', { class: 'note' }, '이 실행을 이어서'),
        ...[20, 40].map((n) => h('button', { class: 'small', onclick: () => continueRun(run, n) }, `+${n}장 더`)))
    : '');
  if (!run) { box.replaceChildren(intro()); return; }

  const board = leaderboard(run, 5);
  const pct = Math.round((run.used / run.budget) * 100);
  const best = board[0]?.c;
  const parts = [
    h('div', { class: 'panel tu-status' },
      h('div', { class: 'row-gap tight' },
        h('b', { class: 'tu-st' }, STATUS[run.status] || run.status),
        h('span', { class: 'note' }, [run.phase, `라운드 ${run.round}`, `${run.used}/${run.budget}장`, run.brain === 'claude' ? `Claude $${run.cost.toFixed(2)}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'grow' }),
        run.error ? h('span', { class: 'bad' }, run.error) : null),
      h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: pct + '%' } })),
      !run.final && !run.waitingPick ? h('div', { class: 'tu-vs' },
        h('figure', {}, h('img', { src: run.refUrl, onclick: () => openLightbox(run.refUrl, '예시') }), h('figcaption', {}, '예시')),
        best ? h('figure', {}, h('img', { src: best.images[0].url, onclick: () => openLightbox(best.images[0].url, best.style_prompt) }), h('figcaption', {}, `현재 1위 · 닮음 ${pctOf(run, best)}`)) : h('div', { class: 'note tu-wait' }, '첫 결과를 기다리는 중…')) : null),
  ];
  if (run.waitingPick) parts.push(pickPanel(run));
  if (run.final) parts.push(finalCard(run));
  if (best && !run.final) {
    parts.push(h('div', { class: 'panel' }, h('h3', {}, '지금 1위 프롬프트'),
      promptBlock('메인', joinP(best.style_prompt, run.lockedPos)),
      promptBlock('네거티브', joinP(best.negative_prompt, run.lockedNeg)),
      h('p', { class: 'note' }, `CFG ${best.scale} · Rescale ${best.cfg_rescale} · ${best.steps}스텝 · ${best.sampler}`)));
  }
  if (board.length) {
    parts.push(det('board', !run.final && !run.waitingPick, h('b', {}, `🏆 순위 상위 ${board.length}`),
      h('div', { class: 'tu-board' }, board.map(({ c }, i) => candRow(run, c, i + 1)))));
  }
  if (run.analysis) parts.push(det('analysis', false, '예시 분석', h('p', { class: 'note pre' }, run.analysis),
    h('p', { class: 'note' }, h('b', {}, '비교용 내용: '), run.content || '-')));
  if (run.rounds.length) {
    parts.push(det('rounds', false, `라운드 기록 (${run.rounds.length})`,
      ...run.rounds.slice().reverse().map((r) => {
        const cs = run.cands.filter((c) => c.round === r.round && c.images.length);
        return h('div', { class: 'tu-round' },
          h('div', { class: 'note' }, h('b', {}, `라운드 ${r.round}`), ' · ', r.critique),
          h('div', { class: 'tu-thumbs' }, cs.map((c) => h('figure', {},
            h('img', { src: c.images[0].url, onclick: () => openLightbox(c.images[0].url, `${c.id} · 닮음 ${pctOf(run, c)}\n${c.rationale}\n${c.style_prompt}`) }),
            h('figcaption', {}, run.brain === 'clip' ? `${c.picked ? '👍 ' : ''}${pctOf(run, c)}` : `${c.claude ?? '-'}점`)))));
      })));
  }
  parts.push(det('log', false, `진행 기록 (${run.log.length})`,
    h('div', { class: 'tu-log' }, run.log.slice(0, 200).map((l) => h('div', { class: 'note ' + (l.kind === 'bad' ? 'bad' : '') }, `${new Date(l.time).toLocaleTimeString('ko-KR')} ${l.msg}`)))));
  box.replaceChildren(...parts);
}

function intro() {
  return h('div', { class: 'panel tu-intro' },
    h('h3', {}, '이렇게 깎아요'),
    h('ol', { class: 'tu-steps' },
      h('li', {}, h('b', {}, '예시 분석 '), '— 애니 전용 태거(WD Tagger v3)로 예시를 Danbooru 태그로 읽어서 내용 프롬프트(인물·옷·구도·배경)와 화풍 태그를 채우고, 비슷한 작가 후보와 채도·대비·선 굵기를 재요. 처음 한 번 모델을 약 380MB 받아요.'),
      h('li', {}, h('b', {}, '조합 · 빼보기 '), '— 분석 상위 작가 5명을 유사도 비례 가중치로 섞어 그리고, 한 명씩 빼보고, 가중치를 바꾸고, 다른 분석 작가로 바꿔봐요. (지금 프롬프트 다듬기는 쓰시던 작가 조합에서 출발)'),
      h('li', {}, h('b', {}, '조합 다듬기 '), '— 제일 닮은 조합에서 가중치 조정·빼기·더하기·바꾸기, 1·2위 섞기를 반복해요.'),
      h('li', {}, h('b', {}, '화풍 태그 '), '— 색감·대비·선·연도·복잡도 태그를 넣고 빼고 세기를 바꿔봐요.'),
      h('li', {}, h('b', {}, '설정·네거티브 '), '— CFG, Rescale, 샘플러, 스텝(모델 범위 안), 네거티브 묶음을 조정해요.'),
      h('li', {}, h('b', {}, '검증 '), '— 상위 후보를 새 시드로 다시 그려서 최종 결과를 정해요.')),
    h('p', { class: 'note' }, '점수 = 애니 태거로 본 그림 유사도 + 화풍 태그가 예시와 얼마나 같은지 + 색감·명암·선 통계 (+ CLIP 조금). 숫자만으로는 눈매나 분위기를 놓치니까 ', h('b', {}, '👍 고르기'), '를 켜두는 걸 추천해요.'),
    h('p', { class: 'note' }, '튜너가 만든 이미지는 히스토리에 🎛 표시로 남아요.'));
}

function candRow(run, c, rank) {
  const key = 'cand-' + c.id;
  const more = h('div');
  const paint = () => {
    btn.textContent = openState[key] ? '접기' : '프롬프트 보기';
    more.replaceChildren(...(openState[key] ? [promptBlock('메인', joinP(c.style_prompt, run.lockedPos)), promptBlock('네거티브', joinP(c.negative_prompt, run.lockedNeg))] : []));
  };
  const btn = h('button', { class: 'small ghost', onclick: () => { openState[key] = !openState[key]; paint(); } });
  paint();
  return h('div', { class: 'tu-cand' },
    h('div', { class: 'tu-rank' }, rank),
    h('div', { class: 'tu-imgs' }, c.images.slice(0, 3).map((im) => h('img', { src: im.url, onclick: () => openLightbox(im.url, `${c.id} · seed ${im.seed}`) }))),
    h('div', { class: 'tu-info' },
      h('div', {}, h('b', {}, `닮음 ${pctOf(run, c)}`),
        h('span', { class: 'note' }, ` · ${c.images.length}장 평균${run.brain === 'claude' ? ` · Claude ${c.claude ?? '-'}` : ''}${c.picked ? ' · 👍' : ''}`)),
      h('div', { class: 'note' }, c.note || c.rationale),
      h('div', { class: 'note' }, `CFG ${c.scale} · Rescale ${c.cfg_rescale} · ${c.steps}스텝 · ${c.sampler}`),
      h('div', { class: 'actions' },
        run.brain === 'clip' ? h('button', { class: 'small ghost' + (c.picked ? ' fav-on' : ''), onclick: () => togglePick(run, c.id) }, c.picked ? '👍 골랐음' : '👍') : null,
        btn,
        h('button', { class: 'small', onclick: () => applyCand(c, run) }, '생성 페이지에 적용'),
        h('button', { class: 'small ghost', onclick: () => copyCand(c, run) }, '복사')),
      more));
}

function finalCard(run) {
  const f = run.final;
  const winner = run.cands.find((c) => c.id === f.winner);
  return h('div', { class: 'panel tu-final' },
    h('h3', {}, '🎉 최종 결과'),
    h('div', { class: 'tu-vs big' },
      h('figure', {}, h('img', { src: run.refUrl, onclick: () => openLightbox(run.refUrl, '예시') }), h('figcaption', {}, '예시')),
      ...(winner ? winner.images.slice(0, 3).map((im) => h('figure', {}, h('img', { src: im.url, onclick: () => openLightbox(im.url, `seed ${im.seed}`) }), h('figcaption', {}, `seed ${im.seed}`))) : [])),
    h('p', { class: 'note pre' }, f.summary),
    promptBlock('메인 프롬프트', joinP(f.style_prompt, run.lockedPos)),
    promptBlock('네거티브 프롬프트', joinP(f.negative_prompt, run.lockedNeg)),
    h('div', { class: 'tu-settings' },
      ...[['모델', MODELS[run.model]?.label], ['CFG', f.scale], ['Rescale', f.cfg_rescale], ['스텝', f.steps], ['샘플러', f.sampler]].map(([k, v]) => h('div', {}, h('span', { class: 'note' }, k), h('b', {}, String(v))))),
    h('div', { class: 'row-gap' },
      h('button', { class: 'primary', onclick: () => applyCand(f, run) }, '생성 페이지에 적용'),
      h('button', { class: 'ghost', onclick: () => copyCand(f, run) }, '전부 복사')),
    h('p', { class: 'note' }, run.brain === 'claude'
      ? '최종 결과는 마지막 검증 뒤 Claude가 다듬은 버전이라 그대로 생성해 본 적은 없을 수 있어요. 적용 후 몇 장 뽑아 확인해 보세요.'
      : (winner?.images.length > 1 ? '여러 시드로 검증한 후보 그대로예요. ' : '장수가 적어서 새 시드 검증은 건너뛰었어요 (48장 이상이면 검증해요). ')
        + '적용한 뒤 캐릭터 프롬프트에 원하는 인물을 넣어 확인해 보세요.'));
}

