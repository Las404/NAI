# 🪚 그깎 — NAI 그림체 깎기

NovelAI Diffusion **V5**에서 작가 태그를 섞고 가중치를 조절해 원하는 그림체를 찾는 정적 웹사이트예요.
빌드 과정 없이 HTML/CSS/JS만으로 돌아가서 **GitHub Pages**에 그대로 올리면 돼요.

사이트: https://las404.github.io/NAI/

## 페이지
| 페이지 | 하는 일 |
|---|---|
| 🎨 **생성** (메인) | 3단 화면이에요. **왼쪽**은 프롬프트·네거티브(가중치 색 표시, 태그 자동완성)와 아래쪽 탭(🎨 작가 믹스 / 🖌 화풍 / 👥 캐릭터 + 위치 / ⚙ 설정), 장수 `− N +`와 생성 버튼이에요. **가운데**는 큰 결과 화면(크기·시드·작가 표시, ⬇ ☆ ↩ 🧪 🗑)이고, **오른쪽**은 히스토리 세로 목록(☆, ✕ 삭제)이에요. `Ctrl+Enter` 생성, `Delete` 삭제, `↑↓`로 히스토리를 이동하고, NAI PNG를 끌어다 놓으면 설정을 불러와요. |
| 🎬 **씬 모드** | 씬마다 프롬프트·네거티브·크기를 저장하고 장수를 예약(+)해 한 번에 뽑아요. 씬 프롬프트는 생성 페이지의 기본 프롬프트 뒤에 붙고, 씬마다 갤러리가 있어요. JSON으로 내보내고 불러올 수 있어요. |
| 🎛 **자동 튜너** | 예시 이미지를 올리면 Claude(Opus 5.5)와 CLIP이 그림체를 분석하고, **내 NAI 계정으로 최대 200장까지 직접 생성해 보면서** 메인 프롬프트(작가·가중치·화풍·퀄리티 태그), 부정 프롬프트, 설정(CFG·Rescale·스텝·샘플러)을 깎아요. 결과는 생성 페이지에 바로 적용할 수 있어요. 본인 Anthropic API 키가 필요해요. |
| 🔎 **작가 찾기** | nax.moe V5 샘플 3종으로 작가 17,554명을 둘러봐요. 검색, 정렬, 랜덤, ⭐ 즐겨찾기, 🚫 숨김을 지원해요. |
| 🖼️ **그림체 분석** | 예시 이미지를 올리면 CLIP으로 비슷한 작가 조합(유사도 비례 가중치)과 화풍 태그를 추천해요. 분석은 브라우저 안에서만 하고 이미지를 어디에도 올리지 않아요. |
| 🧪 **비교 실험** | 시드를 고정하고 믹스만 바꿔서 비교해요. 가중치 스윕과 한 명씩 빼보기를 지원해요. |
| 🕘 **히스토리** | 생성한 이미지와 설정을 브라우저(IndexedDB)에 저장해요. 검색, 즐겨찾기, 불러오기를 지원해요. |
| 🔋 **사용량** | Anlas(구독/구매)와 V5 배터리(%, 충전 시간, 1장당 평균 소모, 남은 장수 추정)를 따로 보여줘요. |

상단에는 💎 Anlas와 🔋 V5 배터리가 늘 따로 표시돼요.

### 자동 튜너 동작
1. **CLIP 분석**: 예시 이미지와 비슷한 작가 후보 40명, 화풍 태그 힌트를 뽑아요.
2. **Claude 분석**: 그림체를 분석하고, 비교용 **내용 프롬프트**(예시의 인물·구도)와 첫 후보 K개를 짜요. 출발점은 "현재 프롬프트에서 다듬기"나 "이미지만 보고 새로" 중에서 골라요.
3. **라운드 반복**: 후보를 같은 시드로 1장씩 생성 → CLIP 유사도 → Claude가 예시와 결과를 나란히 보고 점수(0~10)와 지적을 남긴 뒤 다음 후보 K개를 제안해요.
   - 초반에는 작가 조합 탐색, 중반에는 가중치·화풍·퀄리티 태그, 후반에는 부정 프롬프트와 설정을 다듬어요.
4. **검증·정리**: 상위 3개 후보를 새 시드로 다시 그려 확인하고(예산의 약 10%), 최종 메인·부정 프롬프트, 설정, 설명을 정리해요.
- 종합 점수 = Claude 점수 70% + CLIP 유사도 30%(실행 안에서 정규화)
- "항상 넣을 태그"(예: `-3::loli, child, chibi::`, `nsfw`)는 모든 후보와 최종 결과에 고정으로 들어가요.
- 크기는 예시 비율에 맞춰 832×1216 / 1216×832 / 1024×1024 중에서 고르고, 스텝은 28 이하로 제한해요(무료 조건). Medium effort 모델이면 V5 Full로 바꿔서 돌려요.
- Claude 호출: `claude-opus-5-5`, adaptive thinking, effort high, JSON 스키마 출력, 거절 시 서버 측 대체(`fallbacks: "default"`), 공식 SDK(`@anthropic-ai/sdk`, esm.sh) + `dangerouslyAllowBrowser`
- 비용: 라운드당 대략 $0.1~0.25, 80장(라운드 약 12번)에 $1.5~3 정도예요. 화면에 실시간 누적 비용이 나와요.
- 정지하고 이어하기(+20/+40장)가 돼요. 튜너가 만든 이미지는 히스토리에 🎛 표시로 남아요(자동저장은 안 해요).
- 연속 생성이라 예약 생성과 같은 약관 안내·안전장치가 적용돼요.

### 예약(연속) 생성
생성 페이지의 **N장 예약 생성**이나 씬 모드의 **예약 생성**으로 여러 장을 차례로 뽑아요.
- 안전장치: 한 번에 최대 100장, 장 사이 최소 2초(기본 3초), 동시에 1장만, 언제든 ■ 정지, V5 배터리가 바닥나면 자동 정지(끌 수 있음), 429 오류면 15초 기다렸다가 한 번 재시도, 다른 오류면 정지
- 처음 쓸 때 NovelAI 약관(9.1.6 자동화 금지) 위험 안내를 확인받아요. **계정 제재 위험은 본인 책임**이에요.

### 지우기
생성 화면(🗑, Delete 키, 오른쪽 히스토리 ✕), 씬 갤러리(✕, 즐겨찾기 빼고 / 전부), 히스토리 페이지(여러 장 선택, 즐겨찾기 아닌 것 모두, 전체)에서 지울 수 있어요.
- **자동저장을 "폴더에 바로 저장"으로 켜두면 컴퓨터의 PNG 파일도 같이 지워져요.** 다운로드 폴더로 받은 파일은 브라우저가 손댈 수 없어서 남아요.
- 확인 창에서 "다음부터 묻지 않기"를 고르면 한 장씩 지울 때 바로 지워져요. 히스토리 페이지에서 다시 끌 수 있어요.

### 자동저장
생성 화면의 **💾 자동저장** 버튼에서 켜요.
- **폴더에 바로 저장** (Chrome·Edge): 고른 폴더에 저장하고, 날짜별 하위 폴더도 만들 수 있어요. 씬 모드 이미지는 `씬/씬이름/` 아래에 정리돼요.
- **다운로드 폴더로 자동 다운로드**: 모든 브라우저에서 돼요.
- 파일 이름은 `날짜_시간_시드_작가.png`이고, NAI 메타데이터가 그대로 들어 있어요.

## 구조
```
index.html                 화면 틀 (해시 라우팅 #/, #/scenes, #/artists, #/analyze, #/lab, #/history, #/usage)
css/style.css
js/app.js                  라우팅 · 상단 사용량 · 토큰 창
js/pages/*.js              페이지별 화면
js/state.js                전역 상태(localStorage 자동 저장)
js/nai.js                  NovelAI API (image.novelai.net, zip 해제)
js/generator.js            생성 실행 (한 번 호출 = 한 장)
js/queue.js, queueui.js    예약(연속) 생성 큐 · 진행 바 · 약관 안내
js/prompt.js               프롬프트 조립 · 작가 태그 추출
js/usage.js                Anlas/V5 배터리 조회 · 소모 기록
js/autosave.js             이미지 자동저장
js/png.js                  NAI PNG 메타데이터 읽기
js/autocomplete.js         단부루 태그 자동완성
js/clip.js, clipfeat.js    그림체 분석 (transformers.js CLIP, 특징 벡터)
js/remove.js               이미지 지우기 (히스토리 + 컴퓨터 파일)
js/hilite.js               프롬프트 가중치 색 표시
js/pages/scenes.js         씬 모드
js/tuner.js, pages/tuner.js 자동 그림체 튜너 (엔진 · 화면)
js/claude.js               Claude API 호출 (브라우저, 사용자 키)
js/stylepicker.js          화풍 태그 고르기
assets/artists.json        작가 목록 + 갤러리별 투표 수
assets/tags.json           자동완성 태그 (단부루, 사용 횟수 순)
assets/style-tags.json     화풍 태그 (매체·스타일·색감·효과·V5)
assets/clip/               CLIP 사전 계산 결과 (작가 샘플 임베딩, 화풍 태그 텍스트 임베딩)
tools/embed.html           ↑ 작가 샘플 임베딩 생성 (로컬 serve.ps1에서만)
tools/embed-text.html      ↑ 화풍 태그 텍스트 임베딩 생성
serve.ps1                  로컬 미리보기 서버 (+ tools 결과 저장용 PUT /__save)
NAI_V5_조사정리.md          V5 API·프롬프트 조사 노트
```

## 로컬에서 실행
```
powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 5174
```
브라우저에서 http://localhost:5174 를 열면 돼요.

## 배포
GitHub Desktop에서 **Commit → Push origin**을 누르면 1~2분 뒤 GitHub Pages에 반영돼요.

## 주의
- **Anthropic API 키**(자동 튜너용)도 각자 브라우저에만 저장되고 `api.anthropic.com`으로만 보내요. 공개 사이트라 다른 사람 키는 그 사람 브라우저에만 있어요.
- **API 토큰**은 각자 브라우저에만 저장되고 `image.novelai.net`으로만 보내요. 저장소에 넣거나 공유하면 안 돼요(NovelAI 약관상 계정 공유 금지).
- NovelAI 약관(9.1.6)은 자동화 시스템 사용을 금지해요. 기본 생성은 **버튼 한 번 = 한 장**이에요. 예약(연속) 생성은 이 조항에 걸릴 여지가 있어서, 처음 쓸 때 위험 안내를 확인받고 위의 안전장치를 걸어뒀어요.
- V5는 Opus여도 사용량 배터리를 써요. 배터리가 바닥나면 장마다 Anlas가 빠져요.
- `nai-diffusion-5-full-medium`(Medium effort) 모델 ID는 서드파티 SDK에서 가져온 값이라 공식 확인이 안 됐어요.
- 그림체 분석은 CLIP 추정이에요. 같은 작가의 다른 내용 그림으로 시험하면 5,000명 중 10위 안에 드는 경우가 약 1/3이라, "정확히 그 작가"보다는 "비슷해 보이는 작가 후보"를 찾는 용도예요. 추천 조합은 비교 실험으로 검증하세요.
- 그림체 특징 = CLIP 전체 이미지 임베딩 + 2×2 조각 임베딩 평균 (`js/clipfeat.js`). 100명 대상 실험에서 전체 임베딩만 쓸 때보다 1위 적중률이 37%에서 50%로 올랐어요.

## 크레딧
- 작가 샘플 이미지와 투표: [NovelAI Tag Experiments (nax.moe)](https://nax.moe) by Zelest, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). 샘플 이미지는 nax.moe CDN에서 직접 불러와요. CLIP 임베딩은 이 샘플(투표 상위 5,000명)에서 계산했어요.
- 자동완성 태그: [a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) danbooru.csv (MIT)
- CLIP: [Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32) (OpenAI CLIP, MIT) + [transformers.js](https://github.com/huggingface/transformers.js)
- NovelAI, Anlatan과 관련 없는 개인 프로젝트예요.
