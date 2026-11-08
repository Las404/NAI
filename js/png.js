// NAI가 만든 PNG의 메타데이터(tEXt/iTXt/zTXt) 읽기 → 사이트 설정으로 변환
import { extractArtists } from './prompt.js';
import { QUALITY_SUFFIX } from './nai.js';

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}

export async function readPngText(buffer) {
  const b = new Uint8Array(buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => b[i] === v)) throw new Error('PNG 파일이 아니에요');
  const view = new DataView(buffer);
  const latin = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  const out = {};
  let p = 8;
  while (p + 8 <= b.length) {
    const len = view.getUint32(p);
    const type = latin.decode(b.subarray(p + 4, p + 8));
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      out[latin.decode(data.subarray(0, z))] = utf8.decode(data.subarray(z + 1));
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      out[latin.decode(data.subarray(0, z))] = utf8.decode(await inflate(data.subarray(z + 2)));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      const key = latin.decode(data.subarray(0, z));
      const compressed = data[z + 1] === 1;
      let q = z + 3;
      q = data.indexOf(0, q) + 1; // language tag
      q = data.indexOf(0, q) + 1; // translated keyword
      const txt = data.subarray(q);
      out[key] = utf8.decode(compressed ? await inflate(txt) : txt);
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

function modelFromSource(src = '') {
  const s = src.toLowerCase();
  if (s.includes('v5')) return s.includes('curated') ? 'nai-diffusion-5-curated' : 'nai-diffusion-5-full';
  if (s.includes('v4.5')) return s.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
  return null;
}

// 반환: { mix, settings(부분), raw }
export async function parseNaiPng(file) {
  const text = await readPngText(await file.arrayBuffer());
  if (!text.Comment) throw new Error('NovelAI 메타데이터가 없는 PNG예요 (메타데이터가 지워졌을 수 있어요)');
  const c = JSON.parse(text.Comment);
  let prompt = c.v4_prompt?.caption?.base_caption ?? c.prompt ?? text.Description ?? '';
  const model = modelFromSource(text.Source);

  // 품질 태그가 붙어 있으면 떼어내고 토글로
  let quality = false;
  for (const suffix of new Set(Object.values(QUALITY_SUFFIX))) {
    if (prompt.endsWith(suffix)) { prompt = prompt.slice(0, -suffix.length); quality = true; break; }
  }
  const { mix, rest } = extractArtists(prompt);

  const chars = (c.v4_prompt?.caption?.char_captions || []).map((cc, i) => {
    const neg = c.v4_negative_prompt?.caption?.char_captions?.[i];
    const ctr = cc.centers?.[0];
    const useCoords = !!c.v4_prompt?.use_coords;
    return { prompt: cc.char_caption || '', uc: neg?.char_caption || '', x: useCoords && ctr ? ctr.x : null, y: useCoords && ctr ? ctr.y : null, enabled: true };
  });

  const settings = {
    base: rest,
    quality,
    characters: chars,
    negative: c.v4_negative_prompt?.caption?.base_caption ?? c.uc ?? '',
    steps: c.steps,
    scale: c.scale,
    cfgRescale: c.cfg_rescale ?? 0,
    sampler: c.sampler,
    seed: c.seed,
    size: c.width && c.height ? `${c.width}x${c.height}` : undefined,
  };
  if (model) settings.model = model;
  for (const k of Object.keys(settings)) if (settings[k] === undefined || settings[k] === null) delete settings[k];
  return { mix, settings, raw: { ...text, Comment: c } };
}
