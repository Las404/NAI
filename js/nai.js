// NovelAI 이미지 API 호출 모듈 (브라우저에서 직접 호출: image.novelai.net은 CORS * 허용)
// 근거: NAI_V5_조사정리.md 의 3장 (V5도 v4_prompt / v4_negative_prompt 구조 사용)

const HOST = 'https://image.novelai.net';

export const MODELS = {
  'nai-diffusion-5-full': { label: 'V5 Full', v5: true },
  'nai-diffusion-5-full-medium': { label: 'V5 Full (Medium effort, 실험적)', v5: true, medium: true },
  'nai-diffusion-5-curated': { label: 'V5 Curated', v5: true },
  'nai-diffusion-4-5-full': { label: 'V4.5 Full', v5: false },
  'nai-diffusion-4-5-curated': { label: 'V4.5 Curated', v5: false },
};

// 공식 문서(docs.novelai.net/en/image/qualitytags)의 품질 태그 문자열
export const QUALITY_SUFFIX = {
  'nai-diffusion-5-full': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-5-full-medium': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': ', very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': ', location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': ', location, masterpiece, no text, -0.8::feet::, rating:general',
};

export const SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde'];

// Opus 무료 생성 조건: 1장, txt2img, 1024x1024 픽셀 이하, 28스텝 이하
export function isOpusFree({ width, height, steps }) {
  return width * height <= 1024 * 1024 && steps <= 28;
}

export function buildBody(s) {
  const model = s.model;
  const medium = !!MODELS[model]?.medium;
  const v5 = !!MODELS[model]?.v5;
  const steps = medium ? 14 : s.steps;
  const sampler = medium ? 'k_euler_ancestral' : s.sampler;
  const negative = medium ? '' : s.negative;

  // 캐릭터: [{ prompt, uc, x, y }]  x/y가 null이면 자동 배치
  const maxChars = v5 ? 22 : 6;
  const chars = (s.characters || []).filter((c) => c.prompt && c.prompt.trim()).slice(0, maxChars);
  const useCoords = chars.some((c) => c.x != null && c.y != null);
  const center = (c) => ({ x: c.x ?? 0.5, y: c.y ?? 0.5 });
  const charCaptions = chars.map((c) => ({ char_caption: c.prompt.trim(), centers: [center(c)] }));
  const charNeg = chars.map((c) => ({ char_caption: medium ? '' : (c.uc || '').trim(), centers: [center(c)] }));

  return {
    input: s.prompt,
    model,
    action: 'generate',
    parameters: {
      params_version: v5 ? 4 : 3,
      width: s.width,
      height: s.height,
      scale: s.scale,
      sampler,
      steps,
      n_samples: 1,
      seed: s.seed,
      extra_noise_seed: s.seed,
      cfg_rescale: medium ? 0 : s.cfgRescale,
      noise_schedule: 'karras',
      ucPreset: 3, // 프리셋 문자열은 이 사이트가 직접 negative에 넣음 (3 = None)
      qualityToggle: false, // 품질 태그도 직접 프롬프트에 붙임
      sm: false,
      sm_dyn: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      legacy_v3_extend: false,
      uncond_scale: 1,
      prefer_brownian: true,
      use_coords: useCoords,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      deliberate_euler_ancestral_bug: false,
      characterPrompts: chars.map((c) => ({ prompt: c.prompt.trim(), uc: medium ? '' : (c.uc || '').trim(), center: center(c), enabled: true })),
      negative_prompt: negative,
      reference_image_multiple: [],
      reference_information_extracted_multiple: [],
      reference_strength_multiple: [],
      v4_prompt: {
        caption: { base_caption: s.prompt, char_captions: charCaptions },
        use_coords: useCoords,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: negative, char_captions: charNeg },
        legacy_uc: false,
      },
    },
  };
}

export class NaiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function explain(status, text) {
  const hints = {
    400: '요청 형식 오류',
    401: 'API 토큰이 없거나 잘못됐어요',
    402: 'Anlas가 부족하거나 구독이 필요해요',
    429: '요청이 너무 잦아요. 잠시 후 다시 시도하세요 (동시에 1장씩만)',
    500: '서버 오류 (요청 바디 구조 문제일 수 있어요)',
  };
  return `${status} ${hints[status] || ''} ${text ? '- ' + text.slice(0, 300) : ''}`.trim();
}

export async function generate(token, settings) {
  const body = buildBody(settings);
  const res = await fetch(`${HOST}/ai/generate-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new NaiError(res.status, explain(res.status, text));
  }
  const buf = await res.arrayBuffer();
  const files = await unzip(buf);
  const png = files.find((f) => /\.png$/i.test(f.name)) || files[0];
  if (!png) throw new NaiError(0, '응답 zip 안에 이미지가 없어요');
  return { blob: new Blob([png.data], { type: 'image/png' }), body };
}

export async function getSubscription(token) {
  const res = await fetch(`${HOST}/user/subscription`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new NaiError(res.status, explain(res.status, await res.text().catch(() => '')));
  return res.json();
}

// 최소 zip 리더 (stored / deflate). 중앙 디렉터리 기준으로 읽어서 데이터 디스크립터가 있어도 안전
export async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new NaiError(0, 'zip 형식이 아니에요');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
    } else throw new NaiError(0, `지원하지 않는 zip 압축 방식: ${method}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
