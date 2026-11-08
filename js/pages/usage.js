// 사용량 페이지: Anlas / V5 배터리 / 이 브라우저 생성 통계
import { $, h, fmtDuration } from '../ui.js';
import { on, emit } from '../state.js';
import { token } from '../store.js';
import { usage, summarize, refreshUsage, usageStats } from '../usage.js';

export function mount(el) {
  el.append(
    h('div', { class: 'toolbar' },
      h('h2', { class: 'page-title' }, '사용량'),
      h('span', { class: 'grow' }),
      h('span', { id: 'uTime', class: 'note' }),
      h('button', { class: 'ghost', onclick: () => refreshUsage() }, '↻ 새로고침')),
    h('div', { id: 'uCards', class: 'usage-cards' }),
    h('details', { class: 'panel' }, h('summary', {}, '원본 응답 보기 (/user/subscription)'), h('pre', { id: 'uRaw', class: 'code' })),
  );
  on('usage', render);
  on('generated', render);
}

export function show() { refreshUsage(); render(); }

function bar(pct, cls = '') {
  return h('div', { class: 'meter ' + cls }, h('div', { class: 'meter-fill', style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
}

function render() {
  const box = $('uCards');
  if (!box) return;
  if (!token.get()) {
    box.replaceChildren(h('div', { class: 'panel' }, h('h3', {}, 'API 토큰이 없어요'), h('p', { class: 'note' }, '오른쪽 위 🔑 버튼으로 토큰을 넣으면 Anlas와 V5 사용량을 볼 수 있어요.'),
      h('button', { class: 'primary', onclick: () => emit('needToken') }, '토큰 넣기')));
    return;
  }
  if (usage.error && !usage.sub) {
    box.replaceChildren(h('div', { class: 'panel bad' }, '사용량을 불러오지 못했어요: ' + usage.error.message));
    return;
  }
  const s = summarize(usage.sub);
  if (!s) { box.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'spinner' }))); return; }
  $('uTime').textContent = usage.time ? `${new Date(usage.time).toLocaleTimeString('ko-KR')} 기준` : '';
  $('uRaw').textContent = JSON.stringify(usage.sub, null, 2);
  const st = usageStats();

  // Anlas 카드
  const anlas = h('div', { class: 'ucard' },
    h('div', { class: 'ucard-head' }, h('span', { class: 'ucard-icon' }, '💎'), h('h3', {}, 'Anlas')),
    h('div', { class: 'ucard-big' }, s.anlas.total.toLocaleString()),
    h('div', { class: 'split' },
      h('div', {}, h('div', { class: 'note' }, '구독 Anlas'), h('b', {}, s.anlas.fixed.toLocaleString()), h('div', { class: 'note' }, '갱신 때 다시 채워지고, 구독이 끝나면 0으로 초기화')),
      h('div', {}, h('div', { class: 'note' }, '구매 Anlas'), h('b', {}, s.anlas.purchased.toLocaleString()), h('div', { class: 'note' }, '사라지지 않음 · 구독 Anlas 다 쓴 뒤 사용'))),
    h('div', { class: 'note' }, `${s.tier}${s.expiresAt ? ` · 구독 만료/갱신 ${s.expiresAt.toLocaleDateString('ko-KR')}` : ''}`),
    st.anlasToday ? h('div', { class: 'note' }, `최근 24시간 이 브라우저에서 쓴 Anlas: ${st.anlasToday}`) : null);

  // V5 배터리 카드
  let v5;
  if (s.v5) {
    const p = s.v5.percent;
    const left = st.avgPercent ? Math.floor(Math.max(0, p) / st.avgPercent) : null;
    const fullSec = s.v5.nextPercentSec != null ? Math.max(0, 100 - p) * s.v5.nextPercentSec : null;
    v5 = h('div', { class: 'ucard' + (s.v5.negative ? ' danger' : '') },
      h('div', { class: 'ucard-head' }, h('span', { class: 'ucard-icon' }, '🔋'), h('h3', {}, 'V5 사용량 배터리 (Opus)')),
      h('div', { class: 'ucard-big' }, `${p}%`),
      bar(p, p < 15 ? 'low' : ''),
      s.v5.negative ? h('p', { class: 'bad' }, '배터리가 바닥났어요. 지금 V5로 생성하면 장마다 Anlas가 빠져요. V4.5는 계속 무료예요.') : null,
      h('div', { class: 'split' },
        h('div', {}, h('div', { class: 'note' }, '1% 충전까지'), h('b', {}, fmtDuration(s.v5.nextPercentSec))),
        h('div', {}, h('div', { class: 'note' }, '가득 찰 때까지 (추정)'), h('b', {}, p >= 100 ? '가득 참' : fmtDuration(fullSec)))),
      h('div', { class: 'split' },
        h('div', {}, h('div', { class: 'note' }, '1장당 평균 소모 (이 브라우저 기록)'), h('b', {}, st.avgPercent != null ? `${st.avgPercent.toFixed(2)}%` : '기록 모으는 중'), h('div', { class: 'note' }, st.sample ? `최근 ${st.sample}장 기준` : '')),
        h('div', {}, h('div', { class: 'note' }, '남은 장수 (추정)'), h('b', {}, left != null && isFinite(left) ? `약 ${left.toLocaleString()}장` : '-'))),
      s.v5.boost != null ? h('div', { class: 'note' }, `부스트(예비 배터리): ${s.v5.boost}%`) : null,
      h('p', { class: 'note' }, '배터리는 V5로 생성할 때만 줄어요. 크기·스텝이 클수록 많이 줄고, Medium effort는 약 42% 덜 써요. 퍼센트가 정수로만 와서 1장당 소모량은 여러 장을 평균 내야 정확해져요.'));
  } else {
    v5 = h('div', { class: 'ucard' },
      h('div', { class: 'ucard-head' }, h('span', { class: 'ucard-icon' }, '🔋'), h('h3', {}, 'V5 사용량 배터리')),
      h('p', { class: 'note' }, s.isOpus ? '응답에 배터리 정보가 없어요.' : 'V5 배터리는 Opus 구독에만 있어요. 다른 등급은 V5도 Anlas로 생성해요.'));
  }

  const stats = h('div', { class: 'ucard' },
    h('div', { class: 'ucard-head' }, h('span', { class: 'ucard-icon' }, '📊'), h('h3', {}, '이 브라우저 생성 기록')),
    h('div', { class: 'split' },
      h('div', {}, h('div', { class: 'note' }, '최근 24시간'), h('b', {}, `${st.today}장`)),
      h('div', {}, h('div', { class: 'note' }, '기록된 전체'), h('b', {}, `${st.total}장`))),
    h('p', { class: 'note' }, '생성 전후의 배터리·Anlas를 비교해서 기록해요. 다른 기기나 NovelAI 웹에서 생성한 건 포함되지 않아요.'));

  box.replaceChildren(anlas, v5, stats);
}
