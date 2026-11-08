// 색감·명암·선 통계 (CLIP이 놓치는 "채도·대비·선 굵기"를 숫자로 비교)
//  - 색상(채도 가중)·채도·밝기 히스토그램, 윤곽선 세기 히스토그램, 평균 채도·대비·윤곽 밀도·어두운 선 비율
const SIZE = 224;

function hist(n) { return new Float32Array(n); }
function normalize(a) { let s = 0; for (const x of a) s += x; if (s > 0) for (let i = 0; i < a.length; i++) a[i] /= s; return a; }

export async function imageStats(blob) {
  const bmp = await createImageBitmap(blob);
  const k = SIZE / Math.max(bmp.width, bmp.height);
  const w = Math.max(16, Math.round(bmp.width * k)), h = Math.max(16, Math.round(bmp.height * k));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const gray = new Float32Array(n);
  const hue = hist(12), sat = hist(8), val = hist(8), edge = hist(8);
  let sS = 0, sV = 0, sV2 = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    const s = mx ? c / mx : 0, v = mx;
    let hh = 0;
    if (c > 1e-6) {
      if (mx === r) hh = ((g - b) / c + 6) % 6;
      else if (mx === g) hh = (b - r) / c + 2;
      else hh = (r - g) / c + 4;
      hh /= 6;
    }
    hue[Math.min(11, Math.floor(hh * 12))] += s * v;
    sat[Math.min(7, Math.floor(s * 8))]++;
    val[Math.min(7, Math.floor(v * 8))]++;
    sS += s; sV += v; sV2 += v * v;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  let edges = 0, dark = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      const m = Math.min(1, Math.hypot(gx, gy) / 2);
      edge[Math.min(7, Math.floor(Math.sqrt(m) * 8))]++;
      if (m > 0.18) { edges++; if (gray[i] < 0.3) dark++; }
      cnt++;
    }
  }
  const meanV = sV / n;
  return {
    hue: Array.from(normalize(hue)), sat: Array.from(normalize(sat)), val: Array.from(normalize(val)), edge: Array.from(normalize(edge)),
    meanS: sS / n, meanV, stdV: Math.sqrt(Math.max(0, sV2 / n - meanV * meanV)),
    edgeD: edges / cnt, darkLine: edges ? dark / edges : 0,
  };
}

const inter = (a, b) => a.reduce((s, x, i) => s + Math.min(x, b[i]), 0);

// 0~1 (1 = 같음)
export function statSim(a, b) {
  if (!a || !b) return 0.5;
  const scalar = 1 - Math.min(1,
    Math.abs(a.meanS - b.meanS) * 1.5 + Math.abs(a.stdV - b.stdV) * 2 + Math.abs(a.meanV - b.meanV) * 1 +
    Math.abs(a.edgeD - b.edgeD) * 2.5 + Math.abs(a.darkLine - b.darkLine) * 0.8);
  return 0.12 * inter(a.hue, b.hue) + 0.2 * inter(a.sat, b.sat) + 0.2 * inter(a.val, b.val) + 0.2 * inter(a.edge, b.edge) + 0.28 * scalar;
}

// 예시 이미지 특징을 사람 말로 (튜너 분석 표시·태그 추천용)
export function describeStats(s) {
  const out = [];
  if (s.meanS > 0.42) out.push('vibrant colors');
  else if (s.meanS < 0.12) out.push('monochrome-ish');
  else if (s.meanS < 0.22) out.push('muted color');
  if (s.stdV > 0.29) out.push('high contrast');
  else if (s.stdV < 0.17) out.push('low contrast');
  if (s.meanV > 0.72) out.push('bright');
  else if (s.meanV < 0.38) out.push('dark');
  if (s.edgeD > 0.2) out.push('detailed/lines-heavy');
  else if (s.edgeD < 0.08) out.push('soft/few lines');
  return out;
}
