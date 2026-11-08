# 🪚 그깎 — NAI 그림체 깎기

NovelAI Diffusion **V5**에서 작가 태그를 섞고 가중치를 조절해 원하는 그림체를 찾는 정적 웹사이트예요.
빌드 과정 없이 HTML/CSS/JS만으로 돌아가서 **GitHub Pages**에 그대로 올리면 돼요.

사이트: https://las404.github.io/NAI/

## 페이지
| 페이지 | 하는 일 |
|---|---|
| 🎨 **생성** (메인) | 작가 믹스(가중치 슬라이더) · 프롬프트(태그 자동완성) · 화풍 태그 · 캐릭터 여러 명 + 위치 · 네거티브 · 생성 설정을 왼쪽에, 큰 결과 화면과 최근 결과를 오른쪽에 둬요. `Ctrl+Enter`로 생성하고, NAI PNG를 끌어다 놓으면 설정을 불러와요. |
| 🎬 **씬 모드** | 씬마다 프롬프트·네거티브·크기를 저장하고 장수를 예약(+)해 한 번에 뽑아요. 씬 프롬프트는 생성 페이지의 기본 프롬프트 뒤에 붙고, 씬마다 갤러리가 있어요. JSON으로 내보내고 불러올 수 있어요. |
| 🔎 **작가 찾기** | nax.moe V5 샘플 3종으로 작가 17,554명을 둘러봐요. 검색, 정렬, 랜덤, ⭐ 즐겨찾기, 🚫 숨김을 지원해요. |
| 🖼️ **그림체 분석** | 예시 이미지를 올리면 CLIP으로 비슷한 작가 조합(유사도 비례 가중치)과 화풍 태그를 추천해요. 분석은 브라우저 안에서만 하고 이미지를 어디에도 올리지 않아요. |
| 🧪 **비교 실험** | 시드를 고정하고 믹스만 바꿔서 비교해요. 가중치 스윕과 한 명씩 빼보기를 지원해요. |
| 🕘 **히스토리** | 생성한 이미지와 설정을 브라우저(IndexedDB)에 저장해요. 검색, 즐겨찾기, 불러오기를 지원해요. |
| 🔋 **사용량** | Anlas(구독/구매)와 V5 배터리(%, 충전 시간, 1장당 평균 소모, 남은 장수 추정)를 따로 보여줘요. |

상단에는 💎 Anlas와 🔋 V5 배터리가 늘 따로 표시돼요.

### 예약(연속) 생성
생성 페이지의 **N장 예약 생성**이나 씬 모드의 **예약 생성**으로 여러 장을 차례로 뽑아요.
- 안전장치: 한 번에 최대 100장, 장 사이 최소 2초(기본 3초), 동시에 1장만, 언제든 ■ 정지, V5 배터리가 바닥나면 자동 정지(끌 수 있음), 429 오류면 15초 기다렸다가 한 번 재시도, 다른 오류면 정지
- 처음 쓸 때 NovelAI 약관(9.1.6 자동화 금지) 위험 안내를 확인받아요. **계정 제재 위험은 본인 책임**이에요.

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
js/clip.js                 그림체 분석 (transformers.js CLIP)
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
- **API 토큰**은 각자 브라우저에만 저장되고 `image.novelai.net`으로만 보내요. 저장소에 넣거나 공유하면 안 돼요(NovelAI 약관상 계정 공유 금지).
- NovelAI 약관(9.1.6)은 자동화 시스템 사용을 금지해요. 기본 생성은 **버튼 한 번 = 한 장**이에요. 예약(연속) 생성은 이 조항에 걸릴 여지가 있어서, 처음 쓸 때 위험 안내를 확인받고 위의 안전장치를 걸어뒀어요.
- V5는 Opus여도 사용량 배터리를 써요. 배터리가 바닥나면 장마다 Anlas가 빠져요.
- `nai-diffusion-5-full-medium`(Medium effort) 모델 ID는 서드파티 SDK에서 가져온 값이라 공식 확인이 안 됐어요.
- 그림체 분석은 CLIP 추정이에요. 추천 조합은 비교 실험으로 검증하는 걸 추천해요.

## 크레딧
- 작가 샘플 이미지와 투표: [NovelAI Tag Experiments (nax.moe)](https://nax.moe) by Zelest, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). 샘플 이미지는 nax.moe CDN에서 직접 불러와요. CLIP 임베딩은 이 샘플(투표 상위 5,000명)에서 계산했어요.
- 자동완성 태그: [a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) danbooru.csv (MIT)
- CLIP: [Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32) (OpenAI CLIP, MIT) + [transformers.js](https://github.com/huggingface/transformers.js)
- NovelAI, Anlatan과 관련 없는 개인 프로젝트예요.
