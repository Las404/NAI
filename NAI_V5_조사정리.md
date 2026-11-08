# NovelAI Diffusion V5 조사 정리 (2026-11-08 기준)

> 신뢰도 표시: **[공식]** NovelAI 공식 문서·저널 / **[커뮤니티]** 서드파티 SDK·블로그 실측 (교차확인된 것만 기재, 엇갈리는 건 따로 표시)

---

## 1. 모델 개요

| 항목 | 내용 |
|---|---|
| 출시 | 2026-08-21 **[공식]** |
| 모델 | V5 Full, V5 Curated **[공식]** |
| 규모 | V4.5의 2배 이상, B200 268,000 GPU시간 학습 **[공식]** |
| VAE | 32채널 자체 VAE (V4.5는 16채널) → 눈·장신구·글자 디테일 향상 **[공식]** |
| 프롬프트 | 단부루 태그 + 자연어 둘 다 지원, 영어·일본어 공식 지원 **[공식]** |
| 캐릭터 | 캐릭터 프롬프트 자유 배치 (Character Positioning), 테스트상 22명까지 **[공식]** |
| 만화 | 한 번 생성으로 여러 컷짜리 페이지 **[공식]** |
| 투명 배경 | 알파 채널 출력 지원 **[공식]** |
| 텍스트 | 영·일·중 글자 렌더링, 따옴표로 감싸면 프론트엔드가 `Text:` 블록 자동 생성 **[공식]** |
| Enhance | 새 업스케일러 "Max✨" 단계 추가 **[공식]** |

### V5에서 아직 안 되는 것
- **바이브 트랜스퍼(Vibe Transfer) 불가**, **Precise Reference(캐릭터 레퍼런스) 불가** **[공식, 2026-11 현재까지 추가 발표 없음]**
- V5 Curated 인페인팅은 자체 모델이 없어서 V4.5 Curated 인페인팅으로 대체됨 **[공식]**
- 메타데이터 저장 후 다시 불러올 때 캐릭터 프롬프트 이름은 보존되지 않음 **[공식]**

### 이후 업데이트
- **10/8 Effort 토글** (V5 Full 전용): **[공식]**
  - **High**: 일반 풀 모델
  - **Medium**: 증류(distilled) 모델. **스텝 14 고정, Euler Ancestral 고정, UC(네거티브) 프롬프트·프리셋 변경 불가, CFG Rescale 고정, CFG는 조절 가능**
  - 기본 설정 기준 High(23스텝) 대비 사용량 **약 42% 절약**
  - 네거티브가 필요하면 음수 가중치 사용 (`-3::hat::`)
- **10/13 Opus 사용량 부스트(예비 배터리)**: 무료 사용량을 다 써도 계속 생성할 수 있는 아이템 **[공식]**

---

## 2. 요금·사용량 (그림체 깎기 사이트에서 제일 중요)

- **V5는 Opus도 무제한이 아님.** V4.5 이하는 기존처럼 Opus 무료 생성 조건을 지키면 무제한 **[공식]**
- V5는 Opus 전용 **"사용량 배터리"**를 소모함. 배터리가 바닥나면 **모든 V5 생성에 Anlas가 차감됨** **[공식]**
- 배터리 충전 속도: 첫 30일은 하루 약 11%, 이후 약 14% (꽉 차는 데 7~9일). 한 번 가득 찬 배터리로 기본 23스텝 기준 약 1,730장 **[커뮤니티, 공식 수치 아님]**
- 무료 조건 (Opus): **1장씩 생성, 베이스 이미지 없음(txt2img), 1024×1024 픽셀 이하(=1,048,576 픽셀), 28스텝 이하** **[공식]**
  - 실측: 832×1216 / 28스텝 → 0 Anlas, 1024×1536 → 45 Anlas **[커뮤니티]**
- V5는 기본 단가의 1.5배 **[커뮤니티]**
- 구독 Anlas는 구독 종료 시 0으로 초기화 (2026-09-21부터) **[공식]**

### API로 사용량 확인
- `GET https://image.novelai.net/user/subscription` (**api.novelai.net은 이제 400 에러**)
- 응답의 `usage` 객체: `percent`, `isNegative`, `timeUntilNextPercent` 등
- Anlas 잔액: `trainingStepsLeft` 안의 `fixedTrainingStepsLeft`(구독), `purchasedTrainingSteps`(구매) **[커뮤니티 실측, SDK 두 곳 일치]**

> **사이트 설계 반영**: 그리드 생성 전에 "총 N장, 배터리 약 X% 소모 예상" 경고 + 배터리가 일정 % 이하면 자동 중단. Medium effort를 기본값으로 쓰면 탐색 비용이 크게 줄어듦.

---

## 3. API

> 공식 API 문서는 V5 내용을 아직 공개하지 않음. 아래는 서드파티 SDK 여러 개(novelai-python, ComfyUI 노드 2종)와 실측 글이 **일치하는 내용**만 정리.

### 엔드포인트
| 용도 | 엔드포인트 |
|---|---|
| 생성 (일반) | `POST https://image.novelai.net/ai/generate-image` → **zip 응답** (`image_0.png`) |
| 생성 (스트리밍) | `POST https://image.novelai.net/ai/generate-image-stream` → msgpack 프레임 (중간 미리보기 + 최종 이미지). 웹 클라이언트가 쓰는 방식 |
| 구독/잔액 | `GET https://image.novelai.net/user/subscription` |

- 인증: `Authorization: Bearer <영구 API 토큰>`
- 요청 형식: JSON도 동작함(실측). 웹 클라이언트는 `multipart/form-data`로 보냄. multipart면 Content-Type 직접 지정하지 말 것 (boundary 누락 400)
- **api.novelai.net 호스트는 V5 모델명을 거부함 (400 "model must be a valid enum value")**

### 모델 ID
| 모델 | ID |
|---|---|
| V5 Full | `nai-diffusion-5-full` (실측 200 확인) |
| V5 Full Medium effort | `nai-diffusion-5-full-medium` (SDK 기준, 스텝 14 고정) |
| V5 Curated | `nai-diffusion-5-curated` (실측 200 확인) |
| V5 Full 인페인팅 | `nai-diffusion-5-full-inpainting` |
| V4.5 Full | `nai-diffusion-4-5-full` |

### 요청 바디 골격 (V5, JSON)
```json
{
  "input": "프롬프트",
  "model": "nai-diffusion-5-full",
  "action": "generate",
  "parameters": {
    "params_version": 4,
    "width": 832,
    "height": 1216,
    "steps": 23,
    "scale": 5,
    "sampler": "k_euler_ancestral",
    "noise_schedule": "karras",
    "cfg_rescale": 0,
    "seed": 1234567890,
    "n_samples": 1,
    "negative_prompt": "",
    "v4_prompt": {
      "caption": { "base_caption": "프롬프트", "char_captions": [] },
      "use_coords": false,
      "use_order": true
    },
    "v4_negative_prompt": {
      "caption": { "base_caption": "", "char_captions": [] }
    }
  }
}
```
- **V5도 여전히 `v4_prompt` / `v4_negative_prompt` 구조를 씀.** 둘 중 하나라도 빠지면 **500 에러** **[커뮤니티, 여러 곳 일치]**
- `params_version`: V5는 4 (V4.5 이하는 3)
- 최신 웹 클라이언트는 `ucPreset`·`qualityToggle` 대신 `ucPresetId`·`qualityPresetId`를 씀 **[커뮤니티 SDK]** → 우리 사이트는 품질 태그·UC를 **직접 프롬프트에 붙여서** 보내는 게 가장 안전
- 캐릭터 프롬프트: `char_captions: [{ "char_caption": "...", "centers": [{"x":0.5,"y":0.5}] }]`, 좌표 0.0~1.0 (0.1 단위). V5는 캐릭터 최대 22~32개(SDK마다 다름), V4.5는 6개
- `skip_cfg_above_sigma`(Variety Boost)는 V4/V4.5용, V5엔 해당 없음
- 기본값은 래퍼마다 다름 (스텝 23/28, CFG 5~7) → 웹 기본값은 **23스텝**

### 에러 정리
| 코드 | 원인 |
|---|---|
| 400 | 구 호스트(api.novelai.net) 사용, multipart boundary 누락 |
| 401 | 토큰 없음/잘못됨 |
| 500 | `v4_prompt` 또는 `v4_negative_prompt` 누락 |
| 429 | 동시 요청 (한 번에 1개씩, 간격 두고 보내기 권장) |

### CORS
- 브라우저에서 직접 호출은 막힐 가능성이 높음 → **로컬 중계 서버 필수** (토큰도 서버에만 보관)

---

## 4. 프롬프트·작가 태그 문법

### 가중치 **[공식]**
| 문법 | 효과 |
|---|---|
| `{tag}` | ×1.05 (중첩하면 곱해짐, `{{tag}}` = 1.1025) |
| `[tag]` | ÷1.05 |
| `1.3::tag1, tag2 ::` | 숫자 가중치 (V4 이상). 닫는 `::` 전까지 전부 적용 |
| `-1::hat ::` | 음수 가중치 = 제거·반전 (V4.5 이상) |
| `::` | 열린 `{}` `[]`도 함께 닫음 |

- 실용 범위: 0.5~0.8 약하게, 1.2~1.5 강조, 2.0 강하게, **3.0 이상은 비추천** **[커뮤니티]**
- 프롬프트 믹싱(`|`)은 **V3 이하 전용**, V5에선 안 됨 **[공식]** → 작가 믹스는 **가중치로 섞어야 함**

### 작가 태그 **[커뮤니티]**
- 형식: `artist:작가명` (단부루 아티스트 태그, 언더바 대신 공백)
- V5는 V4.5보다 작가 화풍을 더 잘 따라감. V4.5에서 안 먹던 작가가 V5에서 먹는 경우 많음
- 반대로 **작가마다 효과 편차가 큼**: 안 먹거나, 먹으면 과하게 나오는 작가도 있음 (학습 데이터 포함 여부)
- 작가 태그가 **구도·의상까지 바꾸는** 경우가 있음
- **V4.5에서 깎아둔 조합은 V5에서 그대로 재현 안 됨**, 공식 변환표 없음 → 다시 깎아야 함
- 비교할 땐 **시드 고정 + 한 번에 한 변수만 변경** 권장

### 태그 순서
- 앞에 쓸수록 영향이 큼 → **화풍(작가) → 조명·분위기 → 캐릭터 → 포즈 → 배경** 순서 권장 **[커뮤니티]**

### 품질 태그 (Quality Toggle이 뒤에 붙이는 문자열) **[공식]**
| 모델 | Standard | Light |
|---|---|---|
| V5 Full / Curated | `, very aesthetic, masterpiece, no text` | `, very aesthetic, amazing quality, no text` |
| V4.5 Full | `, location, very aesthetic, masterpiece, no text` | |
| V4.5 Curated | `, location, masterpiece, no text, -0.8::feet::, rating:general` | |

- 품질 태그를 켜면 형태가 안정되지만 작가 개성이 줄어들 수 있음 → **그림체 깎을 땐 끄고/켜고 둘 다 비교할 가치 있음**
- V5 UC(Heavy/Light) 프리셋의 정확한 태그 목록은 공개 안 됨

### V5 전용 화풍 관련 태그 **[공식]**
| 태그 | 효과 |
|---|---|
| `low / medium / high / ultra complexity` | 묘사 복잡도. 일반은 high, 스타일 강한 그림은 low나 ultra |
| `meta:novel era` | 약간 옛날 느낌 |
| `meta:golden era` | 약간 최신 느낌 |
| `depthness` | 음영 깊이 추가 |
| `visual novel art / bg / cg / chibi / sprite` | 비주얼노벨 스타일 |
| `year 2015` 등 | 연도 화풍 (V5 이전부터 있음) |
| `transparent background`, `has alpha`, `alpha transparency` | 투명 배경 |

---

## 5. 작가 데이터 참고 자료
- **tags.gallery**: 같은 시드로 V5 / V4.5 / Illustrious를 작가별로 비교한 견본집 (V4.5 기준 작가 16,352명). 다운로드나 API는 없음
- **ai-nante.com**: V5에서 작가 태그 700개 이상을 같은 프롬프트·시드로 비교한 카탈로그

---

## 6. 사이트 설계에 바로 반영할 것
1. 모델 선택: V5 Full (High/Medium), V5 Curated, V4.5 Full/Curated
2. 생성 엔드포인트는 `image.novelai.net/ai/generate-image` (zip 응답)부터 시작. 미리보기가 필요해지면 stream으로 확장
3. 바디는 반드시 `v4_prompt` + `v4_negative_prompt` 포함, `params_version: 4`
4. 작가 믹스 UI는 `|`가 아니라 **숫자 가중치(`1.2::artist:xxx::`)** 기반
5. 비교·그리드 생성 시 **시드 고정**, 품질 태그 ON/OFF·complexity 태그를 변수로 넣을 수 있게
6. **비용 가드**: 무료 조건(≤1MP, ≤28스텝, 1장, txt2img) 자동 체크 + `/user/subscription`으로 배터리 % 표시, 낮으면 중단
7. 요청은 1개씩 순차 처리 (429 방지)
8. Medium effort면 스텝·샘플러·UC 입력칸 잠금, 네거티브는 음수 가중치로 안내

---

## 출처
- [NovelAI Journal – NovelAI Diffusion V5 is here!](https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/)
- [NovelAI Journal 블로그 목록](https://journal.novelai.net/blog/)
- [NovelAI Docs – Effort Toggle](https://docs.novelai.net/en/image/effort)
- [NovelAI Docs – Subscription](https://docs.novelai.net/en/subscription)
- [NovelAI Docs – Strengthening & Weakening](https://docs.novelai.net/en/image/strengthening-weakening)
- [NovelAI Docs – Tags](https://docs.novelai.net/en/image/tags)
- [NovelAI Docs – Quality Tags](https://docs.novelai.net/en/image/qualitytags)
- [NovelAI Docs – Prompt Mixing](https://docs.novelai.net/en/image/promptmixing/)
- [dev.to – V5 API 직접 호출](https://dev.to/ilan_kim/calling-the-novelai-v5-api-directly-nai-diffusion-5-full-request-body-paramsversion-4310-133a)
- [dev.to – V5 Opus 사용량·호스트 이전](https://dev.to/ilan_kim/novelai-v5-on-opus-usage-limits-the-2026-09-21-subscription-anlas-reset-and-the-apinovelainet-567l)
- [novelai-python (PyPI)](https://pypi.org/project/novelai-python/) / [V5 업데이트 PR](https://github.com/LlmKira/novelai-python/pull/131)
- [ComfyUI_RS_NAI_API_Request](https://github.com/raspie10032/ComfyUI_RS_NAI_API_Request)
- [イツキ AI Lab – V5 화풍 이전 검증](https://note.com/itsuki_ailab/n/na3cc80de57a0)
- [セセのAIブログ – V5/V4.5 화풍 지정 가이드](https://sese2000ai.com/novelai-v45-art-style-guide/)
- [tags.gallery](https://tags.gallery/)
- [ai-nante – V5 작가 태그 카탈로그](https://ai-nante.com/novelai-v5-artist-tags/)
