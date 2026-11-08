// 예약 생성 공용 UI: 시작 확인(약관 안내) + 진행 바
import { h, toast } from './ui.js';
import { on } from './state.js';
import { queue, runQueue, stopQueue, preflight, acknowledged, acknowledge, MAX_JOBS, MIN_DELAY } from './queue.js';
import { prepareAutosave } from './autosave.js';

function ackDialog() {
  return new Promise((resolve) => {
    const cb = h('input', { type: 'checkbox' });
    const ok = h('button', { class: 'primary', disabled: true }, '이해했고 사용할게요');
    cb.addEventListener('change', () => (ok.disabled = !cb.checked));
    const dlg = h('dialog', {},
      h('h3', {}, '⚠ 예약(연속) 생성 전에 꼭 읽어주세요'),
      h('div', { class: 'note', style: { fontSize: '13px', lineHeight: '1.6' } },
        h('p', {}, 'NovelAI 이용약관 9.1.6은 ', h('b', {}, '"자동화 시스템"'), ' 사용을 금지해요. 버튼 한 번으로 여러 장을 연속 생성하는 기능은 여기에 해당한다고 볼 여지가 있고, ',
          h('b', {}, '계정 제재 위험이 있을 수 있어요.'), ' 다른 커뮤니티 도구(NAIS 등)도 같은 기능을 제공하지만 NovelAI가 공식으로 허용한 건 아니에요.'),
        h('p', {}, '이 사이트의 안전장치: 한 번에 최대 ', h('b', {}, `${MAX_JOBS}장`), ', 장 사이 최소 ', h('b', {}, `${MIN_DELAY}초`), ' 간격, 동시에 1장만, 언제든 정지, V5 배터리 소진 시 자동 정지.'),
        h('p', {}, '사용 여부와 책임은 본인에게 있어요. 불안하면 한 장씩 생성(버튼 1번 = 1장)을 쓰세요.')),
      h('label', { class: 'inline', style: { margin: '10px 0' } }, cb, '위 내용을 이해했어요'),
      h('div', { class: 'row-gap end' },
        h('button', { class: 'ghost', onclick: () => { dlg.close(); resolve(false); } }, '취소'),
        ok));
    ok.addEventListener('click', () => { acknowledge(); dlg.close(); resolve(true); });
    dlg.addEventListener('cancel', () => resolve(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}

// jobs: [{ mix, scene }]
export async function startQueue(jobs) {
  if (queue.running) return toast('이미 예약 생성 중이에요');
  if (!jobs.length) return toast('예약된 장이 없어요');
  await prepareAutosave(); // 클릭 직후에 폴더 권한부터 확보 (확인 창을 거치면 권한 요청이 막힐 수 있음)
  if (!acknowledged() && !(await ackDialog())) return;
  const over = jobs.length > MAX_JOBS ? `\n※ 한 번에 최대 ${MAX_JOBS}장이라 앞의 ${MAX_JOBS}장만 생성해요.` : '';
  const warns = preflight(jobs.slice(0, MAX_JOBS));
  const msg = `${Math.min(jobs.length, MAX_JOBS)}장을 ${queue.delay}초 간격으로 생성할까요?${over}${warns.length ? '\n\n⚠ ' + warns.join('\n⚠ ') : ''}`;
  if (!confirm(msg)) return;
  runQueue(jobs).catch((e) => toast(e.message, 'bad'));
}

// 진행 표시 + 정지 버튼 + 간격 설정
export function queueBar() {
  const el = h('div', { class: 'queuebar' });
  let timer = null;
  const render = () => {
    const pct = queue.jobs.length ? Math.round((queue.done / queue.jobs.length) * 100) : 0;
    const wait = queue.waitUntil ? Math.max(0, Math.ceil((queue.waitUntil - Date.now()) / 1000)) : 0;
    el.classList.toggle('active', queue.running);
    el.replaceChildren(
      queue.running
        ? h('div', { class: 'qb-main' },
            h('b', {}, `예약 생성 ${queue.done} / ${queue.jobs.length}`),
            h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: pct + '%' } })),
            h('span', { class: 'note' }, queue.stopping ? '이번 장까지만 하고 멈춰요…' : wait ? `다음 장까지 ${wait}초` : '생성 중…'),
            h('button', { class: 'small danger', disabled: queue.stopping, onclick: stopQueue }, '■ 정지'))
        : h('div', { class: 'qb-main' },
            h('label', { class: 'inline' }, '간격',
              h('input', { type: 'number', min: MIN_DELAY, step: 1, value: queue.delay, style: { width: '4em' }, onchange: (e) => { queue.delay = e.target.value; } }), '초'),
            h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: queue.stopOnEmpty, onchange: (e) => { queue.stopOnEmpty = e.target.checked; } }), 'V5 배터리 바닥나면 멈추기'),
            queue.error ? h('span', { class: 'note bad' }, '마지막 예약: ' + queue.error) : null));
    clearInterval(timer);
    if (queue.running && queue.waitUntil) timer = setInterval(render, 500);
  };
  on('queue', render);
  render();
  return el;
}

on('queueDone', ({ done, total, error }) => {
  toast(error ? `예약 생성 멈춤 (${done}/${total}): ${error}` : `예약 생성 완료 (${done}/${total})`, error ? 'bad' : 'good');
});
