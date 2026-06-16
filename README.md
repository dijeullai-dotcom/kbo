# KBO 정보 페이지

KBO 공식 사이트에서 **당일 경기 일정**과 **팀 순위**를 가져와 보여주는 정적 페이지.
**서버가 필요 없습니다** — GitHub Actions가 주기적으로 데이터를 긁어 `data/*.json`으로 커밋하고,
GitHub Pages가 그 정적 파일을 서빙합니다.

## 구조

```
index.html / style.css / app.js     ← 정적 페이지 (data/*.json 을 읽음)
data/
  rank.json                         ← 팀 순위 (Actions가 생성)
  schedule.json                     ← 경기 일정 (이전·이번·다음 달)
scripts/fetch-data.mjs              ← 스크래퍼 (Node 18+, 의존성 0)
.github/workflows/update-data.yml   ← cron 스케줄로 스크래퍼 실행 + 커밋
```

## 동작 방식

1. GitHub Actions가 스케줄(`update-data.yml`)대로 `scripts/fetch-data.mjs` 실행
2. 스크래퍼가 KBO에서 순위/일정을 긁어 `data/*.json` 갱신 → 변경 있으면 자동 커밋·푸시
3. GitHub Pages가 정적 페이지를 서빙, 브라우저는 `data/*.json`을 읽어 표시
   (같은 저장소의 정적 파일이라 CORS 문제 없음)

## GitHub에 올린 뒤 설정 (2가지)

1. **Pages 켜기** — 저장소 `Settings → Pages → Source: Deploy from a branch → main / (root)`
   → `https://<사용자>.github.io/<저장소>/` 주소로 공개됨
2. **Actions 쓰기 권한** — `Settings → Actions → General → Workflow permissions`
   에서 **Read and write permissions** 선택 (자동 커밋에 필요)

이후 `Actions` 탭에서 **Update KBO data → Run workflow** 로 첫 데이터를 즉시 수집할 수 있습니다.
(이 저장소에는 초기 `data/*.json`이 이미 포함되어 있어 바로 표시됩니다.)

## 로컬에서 데이터 직접 갱신

```bash
node scripts/fetch-data.mjs      # data/*.json 재생성
```

페이지 미리보기는 정적 서버면 됩니다. 예: `python -m http.server 3000` 후 http://localhost:3000

## 스케줄 (UTC 기준 / KST = UTC+9)

- KST 10~24시 30분마다
- 그 외 시간(KST 01~09시) 매시간
- `Actions` 탭에서 수동 실행 가능
- 주기를 바꾸려면 `.github/workflows/update-data.yml`의 `cron` 값만 수정

## 참고

- 데이터 출처: KBO 공식. 비공식 개인용 페이지이며, 사이트 구조가 바뀌면 `fetch-data.mjs` 파싱 수정이 필요할 수 있음.
- 월요일 등 경기 없는 날은 "예정된 경기가 없습니다"로 표시됨(정상).
