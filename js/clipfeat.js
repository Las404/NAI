// 그림체 특징 벡터 (사전 계산 도구와 사이트가 똑같이 사용)
// 전체 이미지 임베딩 + 2×2 조각 임베딩 평균을 더해 정규화.
// 실험(같은 작가의 다른 내용 그림 찾기, 100명 중): 전체만 쓸 때 1위 37%·10위 안 71% → 이 방식 1위 50%·10위 안 80%
export const METHOD = 'global+tiles2x2';

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export async function styleVector({ RawImage, processor, model }, blob) {
  const img = await RawImage.fromBlob(blob);
  const embed = async (im) => normalize((await model(await processor(im))).image_embeds.data);
  const whole = await embed(img);
  const W = img.width, H = img.height;
  const tiles = new Float32Array(whole.length);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const crop = await img.crop([Math.floor((x * W) / 2), Math.floor((y * H) / 2), Math.floor(((x + 1) * W) / 2) - 1, Math.floor(((y + 1) * H) / 2) - 1]);
    const t = await embed(crop);
    for (let i = 0; i < t.length; i++) tiles[i] += t[i];
  }
  const tileMean = normalize(tiles);
  const sum = new Float32Array(whole.length);
  for (let i = 0; i < sum.length; i++) sum[i] = whole[i] + tileMean[i];
  return normalize(sum);
}
