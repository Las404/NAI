// 작가 데이터 (nax.moe V5 갤러리 3종 투표 수 + 이미지 URL 규칙)
// 출처: https://nax.moe (NovelAI Tag Experiments by Zelest), CC BY 4.0

export const GALLERIES = {
  loose: {
    id: 'danbooru-artist-tags-2-v5',
    label: '자유 프롬프트 (여)',
    note: 'artist:___, cowboy shot / girl, facing viewer, fully clothed · V5 Full, 28스텝, CFG 4, 시드 2138582679',
  },
  cons: {
    id: 'danbooru-artist-tags-v5',
    label: '고정 캐릭터 (여)',
    note: '0.75::artist:___::, 흰 배경, 주황 머리 포니테일·검은 후드·청바지 고정 · V5 Full, 16스텝, CFG 4, 시드 4168358238',
  },
  male: {
    id: 'danbooru-artist-tags-male-2-v5',
    label: '자유 프롬프트 (남)',
    note: 'artist:___, 1boy, human, cowboy shot / boy, facing viewer, fully clothed · V5 Full, 15스텝, CFG 7, 시드 302188830',
  },
};

// PHP rawurlencode 와 동일하게 인코딩한 뒤, CDN 경로라서 한 번 더 인코딩 (% -> %25)
function rawurlencode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function imageUrl(tag, gallery = 'loose') {
  const g = GALLERIES[gallery];
  return `https://cdn.zele.st/data/NAX/Images/${g.id}/${rawurlencode(tag + '.webp').replace(/%/g, '%25')}`;
}

// 윌슨 점수 하한 (투표 수가 적은 작가가 과대평가되지 않게)
export function wilson(up, down) {
  const n = up + down;
  if (!n) return 0;
  const z = 1.96;
  const p = up / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

let cache = null;

export async function loadArtists() {
  if (cache) return cache;
  const res = await fetch(new URL('../assets/artists.json', import.meta.url));
  const json = await res.json();
  cache = json.rows.map(([tag, lu, ld, cu, cd, mu, md]) => {
    const g = {};
    if (lu !== null) g.loose = { up: lu, down: ld, score: wilson(lu, ld) };
    if (cu !== null) g.cons = { up: cu, down: cd, score: wilson(cu, cd) };
    if (mu !== null) g.male = { up: mu, down: md, score: wilson(mu, md) };
    return { tag, lower: tag.toLowerCase(), g };
  });
  return cache;
}

// mark: 'all' | 'fav' | 'hidden' / favorites, hidden: Set<tag>  ('all'이면 숨긴 작가는 빠짐)
export function queryArtists(list, { q = '', gallery = 'loose', sort = 'score', minVotes = 0, mark = 'all', favorites, hidden }) {
  const needle = q.trim().toLowerCase().replace(/^artist:\s*/, '').replace(/_/g, ' ');
  let out = list.filter((a) => a.g[gallery]);
  if (mark === 'fav' && favorites) out = out.filter((a) => favorites.has(a.tag));
  else if (mark === 'hidden' && hidden) out = out.filter((a) => hidden.has(a.tag));
  else if (hidden) out = out.filter((a) => !hidden.has(a.tag));
  if (needle) out = out.filter((a) => a.lower.includes(needle));
  if (minVotes > 0) out = out.filter((a) => a.g[gallery].up + a.g[gallery].down >= minVotes);
  const key = {
    score: (a) => -a.g[gallery].score,
    up: (a) => -a.g[gallery].up,
    debated: (a) => -Math.min(a.g[gallery].up, a.g[gallery].down),
    name: null,
  }[sort];
  if (key) out.sort((a, b) => key(a) - key(b) || a.lower.localeCompare(b.lower));
  else out.sort((a, b) => a.lower.localeCompare(b.lower));
  if (needle) {
    // 정확히 일치 / 앞부분 일치를 맨 앞으로
    out.sort((a, b) => rank(a) - rank(b));
  }
  return out;

  function rank(a) {
    if (a.lower === needle) return 0;
    if (a.lower.startsWith(needle)) return 1;
    return 2;
  }
}
