# 🪚 그깎 — NAI 그림체 깎기

NovelAI Diffusion **V5** 작가 태그를 섞고 가중치를 조절해서 원하는 그림체를 찾아가는 정적 웹사이트예요.
빌드 과정 없이 HTML/CSS/JS 파일만으로 돌아가서 **GitHub Pages**에 그대로 올리면 돼요.

## 기능
- **작가 탐색**: 작가 17,554명. nax.moe V5 샘플 이미지 3종(자유 프롬프트 여/남, 고정 캐릭터 여)과 투표 수를 보여줘요. 검색, 추천순·호불호순 정렬, 랜덤 섞기를 지원해요.
- **작가 믹스**: 작가마다 켜기/끄기, 가중치 슬라이더(-1 ~ 2)로 `1.2::artist:xxx::` 형식의 프롬프트를 만들어요. 조합은 프리셋으로 저장할 수 있어요.
- **비교 보드**: 시드를 고정한 채 작가 믹스만 바꿔서 나란히 비교해요.
  - 가중치 스윕: 한 작가의 가중치를 0.6 / 0.8 / 1 / 1.2 / 1.4처럼 바꿔가며 비교
  - 한 명씩 빼보기: 각 작가가 결과에 얼마나 영향을 주는지 확인
- **히스토리**: 생성한 이미지와 설정을 브라우저(IndexedDB)에 저장해요. 즐겨찾기, 설정 불러오기, PNG 저장을 지원해요.
- **비용 표시**: Opus 무료 조건(1MP 이하, 28스텝 이하, 1장) 충족 여부와 V5 사용량 배터리, Anlas 잔액을 보여줘요.

## 구조
```
index.html
css/style.css
js/app.js       화면 로직
js/nai.js       NovelAI API 호출 (image.novelai.net, zip 응답 해제)
js/prompt.js    프롬프트 조립 (작가 가중치, 품질 태그)
js/artists.js   작가 데이터 로드·검색, 샘플 이미지 URL 생성
js/store.js     히스토리(IndexedDB)·설정(localStorage)·토큰 저장
assets/artists.json  작가 목록 + 갤러리별 투표 수
serve.ps1       로컬 미리보기 서버
NAI_V5_조사정리.md   V5 API·프롬프트 조사 노트
```

## 로컬에서 실행
```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
브라우저에서 http://localhost:5173 을 열면 돼요. ES 모듈을 써서 `index.html`을 더블클릭으로 열면 동작하지 않아요.

## GitHub Pages 배포 (GitHub Desktop)
1. GitHub Desktop → **File → Add local repository** → 이 폴더 선택. "create a repository"를 눌러 저장소로 만들어요.
2. **Publish repository**를 눌러요. 비공개로 할지는 아래 "주의"를 보고 정하세요.
3. github.com의 저장소 → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `/ (root)` → Save
4. 1~2분 뒤 `https://<아이디>.github.io/<저장소이름>/` 에서 열려요.

## 주의
- **API 토큰**은 각자 브라우저에만 저장되고, `image.novelai.net` 외의 곳으로는 보내지 않아요. 토큰을 저장소에 넣거나 다른 사람과 공유하면 안 돼요 (NovelAI 약관상 계정 공유 금지).
- NovelAI 약관은 자동화 시스템 사용을 금지해요. 그래서 이 사이트는 **버튼을 한 번 누를 때 한 장만** 생성하고, 자동으로 연속 생성하지 않아요.
- V5는 Opus여도 **사용량 배터리**를 소모해요. 배터리가 다 떨어지면 생성할 때마다 Anlas가 빠져요.
- `nai-diffusion-5-full-medium`(Medium effort) 모델 ID는 서드파티 SDK에서 가져온 값이라 공식으로 확인되지 않았어요.
- 무료 GitHub 계정이면 GitHub Pages는 공개 저장소에서만 쓸 수 있어요.

## 크레딧
- 작가 샘플 이미지와 투표 데이터: [NovelAI Tag Experiments (nax.moe)](https://nax.moe) by Zelest, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). 샘플 이미지는 nax.moe CDN에서 직접 불러와요.
- NovelAI, Anlatan과 관련 없는 개인 프로젝트예요.
