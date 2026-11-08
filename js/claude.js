// Claude API (브라우저에서 사용자 본인의 Anthropic API 키로 직접 호출)
// 공식 TypeScript SDK를 ESM CDN으로 불러옴. 키는 이 브라우저에만 저장.
const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk';
export const CLAUDE_MODEL = 'claude-opus-5-5';

export const claudeKey = {
  get: () => localStorage.getItem('gk.claudeKey') || sessionStorage.getItem('gk.claudeKey') || '',
  set(value, remember) {
    localStorage.removeItem('gk.claudeKey');
    sessionStorage.removeItem('gk.claudeKey');
    if (value) (remember ? localStorage : sessionStorage).setItem('gk.claudeKey', value);
  },
  remembered: () => !!localStorage.getItem('gk.claudeKey'),
};

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import(SDK_URL).then((m) => m.default));

export class ClaudeError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

// 이미지 Blob → 긴 변 maxSide 이하 JPEG base64 (토큰 절약)
export async function blobToClaudeImage(blob, maxSide = 768) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 투명 PNG 대비
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: btoa(bin) } };
}

// content: Anthropic 메시지 content 배열, schema: JSON 스키마 → 파싱된 객체 반환
export async function askClaude({ system, content, schema, effort = 'high', maxTokens = 16000, signal }) {
  const key = claudeKey.get();
  if (!key) throw new ClaudeError('Anthropic API 키가 필요해요', 'nokey');
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  let res;
  try {
    // 거절(refusal) 시 서버가 권장 모델로 자동 재시도하도록 fallbacks: "default" 사용
    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }],
    }, { signal });
    res = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ClaudeError('Anthropic API 키가 올바르지 않아요', 'auth');
    if (e instanceof Anthropic.PermissionDeniedError) throw new ClaudeError('이 API 키로는 사용할 수 없어요 (권한/결제 확인)', 'auth');
    if (e instanceof Anthropic.RateLimitError) throw new ClaudeError('Claude API 요청 한도에 걸렸어요. 잠시 후 다시 시도하세요', 'rate');
    if (e instanceof Anthropic.BadRequestError) throw new ClaudeError('Claude 요청 오류: ' + e.message, 'bad');
    if (e instanceof Anthropic.APIUserAbortError) throw new ClaudeError('중단했어요', 'abort');
    if (e instanceof Anthropic.APIError) throw new ClaudeError(`Claude API 오류 ${e.status ?? ''}: ${e.message}`, 'api');
    throw new ClaudeError('Claude 연결 실패: ' + e.message, 'network');
  }
  if (res.stop_reason === 'refusal') {
    throw new ClaudeError(`Claude가 이 요청을 거절했어요${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}. 이미지나 프롬프트 내용을 확인해 주세요`, 'refusal');
  }
  if (res.stop_reason === 'max_tokens') throw new ClaudeError('Claude 응답이 너무 길어서 잘렸어요', 'truncated');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw new ClaudeError('Claude 응답을 해석하지 못했어요', 'parse'); }
  return { data, usage: res.usage, model: res.model };
}

// 대략적인 비용 (USD) — Opus 5.5: 입력 $4 / 출력 $20 per 1M tokens
export function costOf(usage) {
  if (!usage) return 0;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.05;
  return (input * 4 + (usage.output_tokens || 0) * 20) / 1e6;
}
