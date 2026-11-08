// 자동 그림체 튜너 페이지
import { $, h, toast, openLightbox, dropZone, pickFile } from '../ui.js';
import { state, save, on, emit } from '../state.js';
import { MODELS } from '../nai.js';
import { token, local } from '../store.js';
import { usageStats } from '../usage.js';
import { claudeKey, CLAUDE_MODEL } from '../claude.js';
import { hasClipData } from '../clip.js';
import { tuner, createRun, startRun, stopRun, continueRun, leaderboard, MAX_BUDGET, analyzeReference, togglePick, resolvePick } from '../tuner.js';
import { ensureAck } from '../queueui.js';
import { queue } from '../queue.js';
import { prepareAutosave } from '../autosave.js';

let refBlob = null;
const opt = {
  brain: local.get('tunerBrain', 'clip'),
  humanPick: local.get('tunerHumanPick', false),
  mode: local.get('tunerMode', 'current'),
  budget: local.get('tunerBudget', 80),
  batch: local.get('tunerBatch', 8),
  lockedPos: local.get('tunerLockedPos', '-3::loli, child, chibi::'),
  lockedNeg: local.get('tunerLockedNeg', ''),
  content: '',
};

export function mount(el) {
  el.append(
    h('div', { class: 'tu-layout' },
      h('div', { class: 'tu-left' },
        h('div', { class: 'panel' },
          h('h3', {}, '🎛 자동 그림체 튜너'),
          h('p', { class: 'note' }, '예시 이미지를 올리면 내 NAI 계정으로 여러 장을 직접 뽑아보면서 예시와 비교해 ',
            h('b', {}, '메인 프롬프트(작가·화풍·퀄리티), 부정 프롬프트, 설정(CFG·Rescale·스텝·샘플러)'), '을 깎아요.')),
        h('div', { id: 'tuDrop', class: 'dropzone' },
          h('div', { id: 'tuRef' }, h('div', { class: 'big-emoji' }, '🖼️'), h('div', {}, '예시 이미지를 끌어다 놓거나')),
          h('button', { class: 'primary', onclick: () => pickFile('image/*', setRef) }, '이미지 고르기'),
          h('div', { class: 'note' }, '붙여넣기(Ctrl+V)도 돼요')),
        h('div', { class: 'panel' },
          h('h3', {}, '두뇌'),
          radio('brain', 'clip', '무료 · CLIP 자동', '예시와 결과의 그림체 유사도(CLIP)로 자동 탐색해요. 추가 결제 없음.'),
          radio('brain', 'claude', '유료 · Claude API', 'Claude가 이미지를 직접 보고 비교·수정해요. Anthropic API 키와 결제가 필요해요.'),
          h('label', { class: 'inline', style: { marginTop: '6px' } },
            h('input', { type: 'checkbox', checked: opt.humanPick, onchange: (e) => { opt.humanPick = e.target.checked; local.set('tunerHumanPick', opt.humanPick); } }),
            '라운드마다 멈추고 내가 👍 고르기 (CLIP 모드)'),
          h('div', { class: 'row-gap tight', id: 'tuKeyRow' }, h('b', {}, 'Claude API 키'), h('span', { id: 'tuKey', class: 'note' }), h('span', { class: 'grow' }), h('button', { class: 'small', onclick: openKey }, '🔑 설정')),
          h('div', { class: 'row-gap tight' }, h('b', {}, 'NAI 토큰'), h('span', { id: 'tuNai', class: 'note' })),
          h('div', { class: 'row-gap tight' }, h('b', {}, '그림체 분석 데이터'), h('span', { id: 'tuClip', class: 'note' }))),
        h('div', { class: 'panel' },
          h('h3', {}, '출발점'),
          radio('mode', 'current', '생성 페이지의 현재 프롬프트에서 다듬기', '지금 쓰는 메인·부정 프롬프트를 시작점으로 예시에 맞게 고쳐요.'),
          radio('mode', 'fresh', '예시 이미지만 보고 새로 짜기', '처음부터 새로 설계해요.'),
          h('label', {}, '항상 넣을 태그 (메인)', h('textarea', { rows: 2, value: opt.lockedPos, oninput: (e) => { opt.lockedPos = e.target.value; local.set('tunerLockedPos', opt.lockedPos); } })),
          h('label', {}, '항상 넣을 태그 (부정)', h('textarea', { rows: 2, value: opt.lockedNeg, placeholder: '예: nsfw', oninput: (e) => { opt.lockedNeg = e.target.value; local.set('tunerLockedNeg', opt.lockedNeg); } })),
          h('label', {}, '내용 프롬프트 (비교용)', h('textarea', { id: 'tuContent', rows: 3, placeholder: '비우면 예시 이미지의 인물·구도·배경을 자동으로 추정해요. 모든 후보가 같은 내용을 그려야 그림체만 공정하게 비교돼요.', oninput: (e) => { opt.content = e.target.value; } })),
          h('button', { class: 'small', onclick: preview }, '🔍 예시 분석해서 채우기'),
          h('div', { id: 'tuPreview', class: 'note' })),
        h('div', { class: 'panel' },
          h('h3', {}, '예산'),
          h('label', {}, '생성 장수 ', h('b', { id: 'tuBudgetV' }, opt.budget), `장 (최대 ${MAX_BUDGET})`,
            h('input', { type: 'range', min: 8, max: MAX_BUDGET, step: 4, value: opt.budget, oninput: (e) => { opt.budget = Number(e.target.value); local.set('tunerBudget', opt.budget); $('tuBudgetV').textContent = opt.budget; estimate(); } })),
          h('label', {}, '라운드당 후보 ', h('b', { id: 'tuBatchV' }, opt.batch), '개',
            h('input', { type: 'range', min: 4, max: 12, step: 1, value: opt.batch, oninput: (e) => { opt.batch = Number(e.target.value); local.set('tunerBatch', opt.batch); $('tuBatchV').textContent = opt.batch; estimate(); } })),
          h('div', { id: 'tuEst', class: 'note' }),
          h('div', { class: 'row-gap' },
            h('button', { id: 'tuStart', class: 'primary grow', onclick: start }, '▶ 튜닝 시작'),
            h('button', { id: 'tuStop', class: 'danger', onclick: stopRun }, '■ 정지')),
          h('div', { id: 'tuMore' }))),
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
  render();
}

export function show() { status(); estimate(); render(); }

function radio(name, value, title, desc) {
  return h('label', { class: 'radio-card' + (opt[name] === value ? ' on' : '') },
    h('input', { type: 'radio', name: 'tu-' + name, checked: opt[name] === value, onchange: () => {
      opt[name] = value; local.set(name === 'brain' ? 'tunerBrain' : 'tunerMode', value);
      document.querySelectorAll(`input[name=tu-${name}]`).forEach((r) => r.closest('.radio-card').classList.toggle('on', r.checked));
      status(); estimate();
    } }),
    h('div', {}, h('b', {}, title), h('div', { class: 'note' }, desc)));
}

async function preview() {
  if (!refBlob) return toast('예시 이미지를 먼저 올려주세요');
  $('tuPreview').textContent = '분석 중… (처음엔 CLIP 모델을 받느라 조금 걸려요)';
  try {
    const r = await analyzeReference(refBlob);
    opt.content = r.content;
    $('tuContent').value = r.content;
    $('tuPreview').textContent = `비슷한 작가: ${r.artists.slice(0, 8).map((a) => a.tag).join(', ')} · 두드러진 화풍: ${r.styleHints.join(', ') || '없음'}`;
  } catch (e) {
    $('tuPreview').textContent = '분석 실패: ' + e.message;
  }
}

function setRef(file) {
  refBlob = file;
  const url = URL.createObjectURL(file);
  $('tuRef').replaceChildren(h('img', { src: url, class: 'tu-ref', onclick: () => openLightbox(url, '예시 이미지') }));
}

async function status() {
  if (!$('tuKey')) return;
  $('tuKeyRow').hidden = opt.brain !== 'claude';
  $('tuKey').textContent = claudeKey.get() ? `✓ 있음 (${CLAUDE_MODEL})` : '없음';
  $('tuKey').className = 'note ' + (claudeKey.get() ? 'good-text' : 'bad');
  $('tuNai').textContent = token.get() ? '✓ 있음' : '없음 (오른쪽 위 🔑)';
  $('tuNai').className = 'note ' + (token.get() ? 'good-text' : 'bad');
  const ok = await hasClipData();
  $('tuClip').textContent = ok ? '✓ 준비됨' : '없음 (CLIP 후보 없이 진행)';
}

function estimate() {
  const st = usageStats();
  const rounds = Math.ceil(opt.budget / opt.batch) + 2;
  const battery = st.avgPercent ? `V5 배터리 약 ${(st.avgPercent * opt.budget).toFixed(0)}%` : 'V5 배터리 소모는 기록이 쌓이면 표시';
  $('tuEst').textContent = opt.brain === 'claude'
    ? `라운드 약 ${rounds}번 · ${battery} · Claude 비용 대략 $${(rounds * 0.12).toFixed(1)}~${(rounds * 0.25).toFixed(1)} (Opus 5.5 기준 추정)`
    : `라운드 약 ${rounds}번 · ${battery} · 추가 비용 없음 (CLIP은 브라우저에서 계산)`;
}

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
  const how = opt.brain === 'claude' ? `Claude(${CLAUDE_MODEL})로 평가해요` : `CLIP 그림체 유사도로 평가해요${opt.humanPick ? ' (라운드마다 멈추고 👍 고르기)' : ''}`;
  const msg = `${opt.budget}장까지 ${queue.delay}초 간격으로 자동 생성하면서 ${how}.\n크기는 예시 비율에 맞춰 832×1216 / 1216×832 / 1024×1024 중에서 골라요 (무료 조건 안).\n모델: ${MODELS[s.model]?.medium ? 'V5 Full' : MODELS[s.model]?.label}\n언제든 ■ 정지할 수 있어요. 시작할까요?`;
  if (!confirm(msg)) return;
  const run = createRun({
    refBlob, mode: opt.mode,
    startPos: opt.mode === 'current' ? currentMainPrompt() : '',
    startNeg: opt.mode === 'current' ? s.negative : '',
    lockedPos: opt.lockedPos, lockedNeg: opt.lockedNeg,
    budget: opt.budget, batch: opt.batch, model: s.model, content: opt.content.trim(),
    brain: opt.brain, humanPick: opt.humanPick,
    startSettings: { scale: s.scale, cfgRescale: s.cfgRescale, steps: s.steps, sampler: s.sampler },
  });
  startRun(run);
}

// 생성 페이지 상태를 하나의 메인 프롬프트 문자열로
function currentMainPrompt() {
  const s = state.settings;
  const parts = [];
  for (const a of state.mix) if (a.enabled !== false) parts.push(Math.abs(a.weight - 1) < 1e-6 ? `artist:${a.tag}` : `${a.weight}::artist:${a.tag}::`);
  for (const t of s.styleTags) parts.push(Math.abs(t.weight - 1) < 1e-6 ? t.tag : `${t.weight}::${t.tag}::`);
  if (s.base) parts.push(s.base);
  return parts.join(', ');
}

function applyCand(c, run) {
  if (!confirm('생성 페이지의 메인·부정 프롬프트와 설정을 이 결과로 바꿀까요?\n(작가 믹스·화풍 태그 칸은 비우고, 결과 프롬프트에 모두 들어가요. 뒤에 원하는 내용 태그를 붙여 쓰세요.)')) return;
  const join = (...p) => p.map((x) => (x || '').trim()).filter(Boolean).join(', ');
  state.mix = [];
  Object.assign(state.settings, {
    base: join(c.style_prompt, run.lockedPos) + ', ',
    negative: join(c.negative_prompt, run.lockedNeg),
    quality: false, styleTags: [],
    scale: c.scale, cfgRescale: c.cfg_rescale, steps: c.steps, sampler: c.sampler, model: run.model,
  });
  save.mix(); save.settings();
  toast('생성 페이지에 적용했어요', 'good');
}

function copyCand(c, run) {
  const join = (...p) => p.map((x) => (x || '').trim()).filter(Boolean).join(', ');
  navigator.clipboard.writeText(`[메인]\n${join(c.style_prompt, run.lockedPos)}\n\n[부정]\n${join(c.negative_prompt, run.lockedNeg)}\n\n[설정] CFG ${c.scale} · Rescale ${c.cfg_rescale} · 스텝 ${c.steps} · ${c.sampler}`);
  toast('복사했어요');
}

const STATUS = { idle: '대기', analyzing: '🔍 분석 중', generating: '🎨 생성 중', judging: '🧠 Claude 평가 중', validating: '✅ 검증 중', picking: '👍 고르는 중', done: '🎉 완료', stopped: '⏸ 멈춤', error: '❌ 오류' };

// 라운드가 끝나고 내가 고르는 화면
function pickPanel(run) {
  const cs = run.cands.filter((c) => c.round === run.round && c.images.length);
  return h('div', { class: 'panel tu-pick' },
    h('div', { class: 'row-gap tight' },
      h('h3', {}, `👍 라운드 ${run.round}: 예시에 가까운 걸 골라주세요`),
      h('span', { class: 'grow' }),
      h('button', { class: 'primary', onclick: () => resolvePick(run) }, '다음 라운드 ▶')),
    h('p', { class: 'note' }, `${run.phase || ''} · 고른 후보는 점수 보너스를 받아서 다음 후보의 중심이 돼요. 안 골라도 돼요 (CLIP 점수로 진행).`),
    h('div', { class: 'tu-pickgrid' },
      h('figure', { class: 'ref' }, h('img', { src: run.refUrl, onclick: () => openLightbox(run.refUrl, '예시') }), h('figcaption', {}, '예시')),
      cs.map((c) => h('figure', { class: c.picked ? 'on' : '' },
        h('img', { src: c.images[0].url, onclick: () => togglePick(run, c.id), title: '눌러서 👍' }),
        h('figcaption', {}, `${c.picked ? '👍 ' : ''}${c.id} · CLIP ${c.images[0].clip.toFixed(3)}`),
        h('div', { class: 'note tu-why' }, c.rationale)))));
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
  if (!run) {
    box.replaceChildren(h('div', { class: 'panel' },
      h('h3', {}, '어떻게 동작하나요?'),
      h('h4', {}, '무료 · CLIP 자동'),
      h('ol', { class: 'note tu-steps' },
        h('li', {}, '예시 이미지를 CLIP으로 분석해서 비슷한 작가 후보 40명, 두드러진 화풍 태그, 비교용 내용 프롬프트(인물·구도·배경)를 뽑아요.'),
        h('li', {}, '① 작가 단독 시험: 후보 작가를 한 명씩 같은 시드로 그려서 예시와 얼마나 비슷한지 재요.'),
        h('li', {}, '② 작가 조합·가중치: 잘 나온 작가들을 2~4명 섞고, 가중치를 올리고 내리고, 빼고 더하면서 점수가 오르는 쪽으로 진화시켜요.'),
        h('li', {}, '③ 화풍 태그: CLIP이 찾은 화풍 태그와 V5 복잡도 태그를 하나씩 넣고 빼봐요.'),
        h('li', {}, '④ 설정·부정 프롬프트: CFG, Rescale, 스텝, 샘플러, 부정 프롬프트 변형을 시험해요.'),
        h('li', {}, '⑤ 상위 3개를 새 시드로 다시 그려서 우연히 잘 나온 게 아닌지 확인하고 최종 결과를 정해요.')),
      h('p', { class: 'note' }, '"내가 👍 고르기"를 켜면 라운드마다 멈춰서, 내가 고른 후보를 중심으로 다음 후보를 만들어요. CLIP은 숫자로만 비교해서 세부를 놓칠 수 있는데, 내 눈으로 보정하는 방식이에요.'),
      h('h4', {}, '유료 · Claude API'),
      h('p', { class: 'note' }, 'Claude가 예시와 결과를 직접 보고 점수와 지적을 남기며 프롬프트를 고쳐요 (종합 점수 = Claude 70% + CLIP 30%). Anthropic API 키와 결제가 필요해요.'),
      h('p', { class: 'note' }, '튜너가 만든 이미지는 히스토리에 🎛 표시로 남아요.')));
    return;
  }
  const board = leaderboard(run, 6);
  const pct = Math.round((run.used / run.budget) * 100);
  const parts = [
    h('div', { class: 'panel tu-status' },
      h('div', { class: 'row-gap tight' },
        h('b', {}, STATUS[run.status] || run.status),
        h('span', { class: 'note' }, `라운드 ${run.round} · ${run.used}/${run.budget}장 · Claude 약 $${run.cost.toFixed(2)}`),
        h('span', { class: 'grow' }),
        run.error ? h('span', { class: 'bad' }, run.error) : null),
      h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: pct + '%' } }))),
  ];
  if (run.waitingPick) parts.push(pickPanel(run));
  if (run.final) parts.push(finalCard(run));
  if (run.analysis) parts.push(h('div', { class: 'panel' }, h('h3', {}, '그림체 분석'), h('p', { class: 'note pre' }, run.analysis),
    h('p', { class: 'note' }, h('b', {}, '비교용 내용 프롬프트: '), run.content)));
  if (board.length) {
    parts.push(h('div', { class: 'panel' }, h('h3', {}, '🏆 지금까지 순위'),
      h('div', { class: 'tu-board' }, board.map(({ c, s }, i) => candRow(run, c, s, i + 1)))));
  }
  if (run.rounds.length) {
    parts.push(h('div', { class: 'panel' }, h('h3', {}, '라운드 기록'),
      ...run.rounds.slice().reverse().map((r) => {
        const cs = run.cands.filter((c) => c.round === r.round && c.images.length);
        return h('div', { class: 'tu-round' },
          h('div', { class: 'note' }, h('b', {}, `라운드 ${r.round}`), ' · ', r.critique),
          h('div', { class: 'tu-thumbs' }, cs.map((c) => h('figure', {},
            h('img', { src: c.images[0].url, onclick: () => openLightbox(c.images[0].url, `${c.id} · Claude ${c.claude ?? '-'} · CLIP ${c.images[0].clip.toFixed(3)}\n${c.rationale}\n${c.style_prompt}`) }),
            h('figcaption', {}, run.brain === 'clip' ? `${c.picked ? '👍 ' : ''}${c.id} · ${c.images[0].clip.toFixed(3)}` : `${c.id} · ${c.claude ?? '-'}점`)))));
      })));
  }
  parts.push(h('details', { class: 'panel' }, h('summary', {}, `진행 기록 (${run.log.length})`),
    h('div', { class: 'tu-log' }, run.log.slice(0, 200).map((l) => h('div', { class: 'note ' + (l.kind === 'bad' ? 'bad' : '') }, `${new Date(l.time).toLocaleTimeString('ko-KR')} ${l.msg}`)))));
  box.replaceChildren(...parts);
}

function candRow(run, c, s, rank) {
  return h('div', { class: 'tu-cand' },
    h('div', { class: 'tu-rank' }, rank),
    h('div', { class: 'tu-imgs' }, c.images.slice(0, 3).map((im) => h('img', { src: im.url, onclick: () => openLightbox(im.url, `${c.id} · seed ${im.seed} · CLIP ${im.clip.toFixed(3)}`) }))),
    h('div', { class: 'tu-info' },
      h('div', {}, h('b', {}, c.id),
        h('span', { class: 'note' }, run.brain === 'clip'
          ? ` CLIP ${s.clip != null ? s.clip.toFixed(3) : '-'} (${c.images.length}장 평균)`
          : ` 종합 ${s.total.toFixed(2)} · Claude ${c.claude ?? '-'} · CLIP ${s.clip != null ? s.clip.toFixed(3) : '-'}`),
        run.brain === 'clip' ? h('button', { class: 'small ghost' + (c.picked ? ' fav-on' : ''), style: { marginLeft: '6px' }, onclick: () => togglePick(run, c.id) }, c.picked ? '👍 골랐음' : '👍') : null),
      h('div', { class: 'note' }, c.note || c.rationale),
      h('code', { class: 'tu-prompt' }, c.style_prompt),
      h('div', { class: 'note' }, `부정: ${c.negative_prompt || '-'}`),
      h('div', { class: 'note' }, `CFG ${c.scale} · Rescale ${c.cfg_rescale} · ${c.steps}스텝 · ${c.sampler}`),
      h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => applyCand(c, run) }, '생성 페이지에 적용'),
        h('button', { class: 'small ghost', onclick: () => copyCand(c, run) }, '복사'))));
}

function finalCard(run) {
  const f = run.final;
  const winner = run.cands.find((c) => c.id === f.winner);
  const join = (...p) => p.map((x) => (x || '').trim()).filter(Boolean).join(', ');
  return h('div', { class: 'panel tu-final' },
    h('h3', {}, '🎉 최종 결과', winner ? h('span', { class: 'note' }, ` (우승 ${winner.id} 기반)`) : null),
    winner ? h('div', { class: 'tu-imgs big' }, winner.images.slice(0, 4).map((im) => h('img', { src: im.url, onclick: () => openLightbox(im.url, `seed ${im.seed}`) }))) : null,
    h('p', { class: 'note pre' }, f.summary),
    h('div', { class: 'tu-out' }, h('b', {}, '메인 프롬프트'), h('pre', { class: 'code' }, join(f.style_prompt, run.lockedPos))),
    h('div', { class: 'tu-out' }, h('b', {}, '부정 프롬프트'), h('pre', { class: 'code' }, join(f.negative_prompt, run.lockedNeg))),
    h('div', { class: 'tu-out' }, h('b', {}, '설정'), h('pre', { class: 'code' }, `모델 ${MODELS[run.model]?.label} · CFG ${f.scale} · Rescale ${f.cfg_rescale} · 스텝 ${f.steps} · 샘플러 ${f.sampler}`)),
    h('div', { class: 'row-gap' },
      h('button', { class: 'primary', onclick: () => applyCand(f, run) }, '생성 페이지에 적용'),
      h('button', { class: 'ghost', onclick: () => copyCand(f, run) }, '전부 복사')),
    h('p', { class: 'note' }, run.brain === 'claude'
      ? '최종 결과는 마지막 검증 뒤 Claude가 다듬은 버전이라 그대로 생성해 본 적은 없을 수 있어요. 적용 후 몇 장 뽑아 확인해 보세요.'
      : '여러 시드로 검증한 후보 그대로예요. 적용한 뒤 내용 프롬프트를 바꿔서 몇 장 뽑아 확인해 보세요.'));
}
