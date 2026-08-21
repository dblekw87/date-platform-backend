# date-platform-backend

[DATE](https://github.com/dblekw87/date-platform)의 API 서버이자, **장중 내내 도는
시장 수집기**입니다.

외부 provider 호출과 시크릿을 전부 이쪽이 소유하고, 프론트는 정규화된 DTO를 받아
표시만 합니다. provider 자격증명은 브라우저를 향하는 프로세스에 절대 닿지 않습니다.

## 이 저장소가 실제로 하는 일

한국·미국 시장을 세 세션 모두 따라가며 표본을 남기고, 그 기록 위에서 테마와 짝꿍
후보를 계산합니다.

| 무엇을 | 언제 | 어디에 |
| --- | --- | --- |
| 국내 주도주·짝꿍 후보 | 08:00~20:00, 개장 30분은 1분 간격 | `market_price_samples` |
| 국내 전 종목 훑기 | 정규장 5분 간격, 450여 종목 | 같은 표, `:seen` source |
| 미국 프리·정규·애프터 | 17:00~09:00, 1,200여 종목 | 같은 표 |
| 뉴스 | 상시(장중 10분·장 외 45분), 원문 payload 포함 | `market_news_items` |
| 국내 공시 | 07:00~20:00 5분 간격, 20:10 전체 훑기 | `market_disclosures` |
| 프로그램 매매 | 정규장 5분 간격, 상위 40종목 | `kr_program_trade` |
| 투자자별 매매동향 | 매일 16:10 | `kr_investor_flow` |
| 시장 지정(관리종목·투자경고) | 시세 조회에 묻어옴 | `kr_symbol_flags` |
| 미국 공매도 잔고 · 일별 거래량 | 격주 / 매일 | `us_short_interest`, `us_short_volume` |
| 지분 그래프(타법인출자) | 연 1회 | `kr_ownership_edges` |

수집기는 데스크톱에서 돌고, 배포된 프론트는 여기 닿을 수 없습니다. 그래서 DB를
클라우드로 올리는 대신 **그려진 보드 한 장**만 공개 저장소로 내보냅니다
(`npm run snapshot:publish`). 키도 원본 payload도 나가지 않습니다.

## 측정해서 알게 된 것

기능보다 **재보고 틀렸다는 걸 안 것들**이 이 프로젝트의 실제 내용입니다.

- **순위 열쇠구멍.** 거래대금 순위권 안에 있을 때만 종목이 보이므로 기록에는 움직임의
  중간만 남고 시작과 끝이 없습니다. SHD는 단 한 틱만 찍혔는데 그게 상한가이자 순위
  2위였습니다 — 따라 들어갈 시간이 없습니다. 그래서 한 번 본 종목은 순위와 무관하게
  계속 따라가는 패스를 따로 둡니다. 미국도 같은 구멍이 정규장에 다시 열려서, 브로커
  화면의 +20% 이상 종목 중 우리 보드에 있던 건 하나뿐이었습니다.
- **닫힌 호가창에 묻기.** KRX는 15:30 이후, NXT는 08:50 이후, 야후 스크리너는 정규장
  밖에서 값이 얼어붙습니다. 그대로 받으면 죽은 가격을 실시간으로 기록합니다. 세 번 다
  같은 실수였습니다. **시세는 열려 있는 호가창에, 순위는 끝난 하루에** 묻는 것으로
  나눴습니다 — 상한가 9종목 중 보드에 1개만 뜨던 게 8개가 됐습니다.
- **테마는 산업이 아니라 "오른 이유"입니다.** 좋은사람들은 속옷을 팔지만 그날 상한가
  간 이유는 개성공단입니다. KSIC 업종으로는 안 묶이고, 같은 테마에 의류·리조트·철도·
  시멘트가 함께 들어옵니다. 분류는 큐레이션 사전 → 네이버 테마 사전(2,391종목) →
  종목명 규칙 → 등록 업종 순으로 내려갑니다.
- **프리마켓은 진입 구간이 아닙니다.** 프리마켓 10% 이상 오른 8종목 중 7종목이 개장
  전에 상승분을 대부분 반납했습니다. 쓸 수 있는 신호는 상승폭이 아니라 프리마감 대비
  정규시작 **유지율**이었습니다.
- **격주 잔고와 일별 플로우는 다른 데이터입니다.** 미국 동전주 급등이 숏커버링이
  아니라는 결론은 격주 공매도 **잔고**로 잰 것입니다. FINRA가 매일 내는 공매도
  **거래량**은 다른 질문에 답합니다.
- **키가 없어도 열려 있는 것이 꽤 있습니다.** DART 타법인출자현황(전 상장사 36,936
  엣지), FINRA 공매도 파일, SEC EDGAR, 네이버 테마 사전이 전부 무료였습니다. 반대로
  KIS 시세 응답에는 종목명이 없어서 DART 기업 인덱스로 채워야 했습니다.

## 머신러닝을 어떻게 돌리고 있는가

### 원칙 — 학습은 읽기만 합니다

`analysis/`에 파이썬(pandas·NumPy·SciPy·scikit-learn)이 있고, Node 쪽과 **PostgreSQL
하나만 공유**합니다. 쓰기는 전부 수집기가 합니다.

학습 실행이 자기가 배울 기록을 바꿀 수 있으면 그 실행은 아무도 재현할 수 없습니다.
그래서 `analysis/db.py`는 조회만 하고, 커넥션 문자열도 백엔드 `.env`에서 그대로
읽어 설정이 두 곳에 생기지 않게 합니다.

```powershell
python -m venv analysis\.venv
.\analysis\.venv\Scripts\python.exe -m pip install -r analysis\requirements.txt
.\analysis\.venv\Scripts\python.exe analysis\run_persistence.py
```

### 왜 파이썬이 따로 있는가

JS 쪽 `npm run theme:candidates`는 **하루**를 묶습니다 — 미분류 급등 종목 중 같은 틱에
함께 오른 그룹을 찾아 거래대금 순으로 내놓고, 멤버 이름이 들어간 헤드라인을 붙입니다.

파이썬이 맡는 것은 하루로는 알 수 없는 것, **같은 쌍이 다시 오는가**입니다. 한 번 같이
움직인 쌍은 우연이고, 매주 같이 움직이는 쌍이 테마입니다.

### 지금 돌리는 것 — 동반 상승 쌍의 반복성

`analysis/comovement.py`가 하루치 틱을 읽어 방향 있는 쌍을 뽑고,
`run_persistence.py`가 그것을 날짜에 걸쳐 누적합니다. 설계 결정 넷은 전부 JS 쪽에서
먼저 틀려보고 옮겨온 것입니다.

- **상관은 틱 차분으로 잽니다.** `change_rate`는 전일 종가 대비 누적이라, 레벨로 재면
  그날 오른 종목끼리 전부 상관이 높게 나옵니다. 차분을 써야 같은 분에 매수된 종목이
  갈립니다.
- **쌍을 클러스터로 키우지 않습니다.** single linkage는 0.6짜리 약한 고리 하나로 무관한
  두 그룹을 붙여버립니다 — 첫 실행에서 진짜 쌍 하나에 신규상장 바이오까지 딸려왔습니다.
- **쌍에는 방향이 있고, 방향은 크기를 따릅니다.** 삼성전기가 오르면 삼화콘덴서가
  따라가지 반대로는 잘 안 갑니다. 무방향 상관은 서로 바꿔도 되는 쌍처럼 다루는데,
  매매가 성립하는 건 한 방향뿐입니다.
- **상한가는 측정불가로 둡니다.** 분산이 0이라 상관이 정의되지 않습니다. 0으로 채우면
  "상관 없음"이 되는데, 그건 사실이 아닙니다.

첫 실행(2일치)에서 579쌍 중 이틀 다 나온 것이 25쌍이었고, **25쌍 전부 로봇**이었습니다.
그중 20쌍은 서로 다른 테마 라벨로 갈라져 있습니다 — 로봇 / 로봇(산업용·협동로봇) /
스마트팩토리 / 피지컬 AI·휴머노이드. 시장은 하나로 거래하는데 사전은 넷으로 쪼개
놨다는 뜻입니다. 반대로 반도체는 제대로 하나로 묶여 있었습니다.

**이틀치로 라벨을 합치지는 않았습니다.** 측정이 동작한다는 것까지가 지금 말할 수 있는
전부입니다.

### 아직 학습에 들어가지 않은 것과, 그 이유

| 하려는 것 | 막고 있는 것 |
| --- | --- |
| 헤드라인 → "오른 이유" 라벨 분류 | 학습셋. 장중에만 뉴스를 담던 것을 24시간으로 바꿔 지금 쌓는 중입니다. 원문 payload도 함께 저장합니다 |
| 후보 이유 순위 학습 | 국내 분봉 이력. 전 종목 수집은 최근에 시작됐습니다 |
| 테마 클러스터 확정 | 2주치 동반 상승 기록 |
| 짝꿍 성공률·적정 진입 시각 | 3개월치 |

마일스톤이 달력에 막혀 있는 동안 할 수 있는 것은 **파이프라인을 미리 세워두는 것**과
**측정이 망가지지 않게 하는 것**입니다. 열쇠구멍을 막은 것도, 수집기가 표본을 빠뜨리지
않는지 매일 확인하는 것도 그래서입니다 — 데이터가 새는 상태로 2주를 보내면 2주를
버립니다.

### 규칙으로 되는 것과 안 되는 것

"왜 올랐나"를 정규식으로 재봤더니, 잡히는 것은 **주어가 그 종목 자신일 때뿐**이었습니다
(자사주 소각, 증설 발표). 못 잡는 것은 지분 가치 변동, 방어주 선호, 요금제 개편 같은
것들이고, 더 나쁜 것은 "엔비디아 실적 호조에 국내 반도체 상승"을 심텍의 **실적**으로
잘못 분류한 것이었습니다. 엔비디아의 실적이지 심텍의 실적이 아닙니다.

이유는 **(주체, 사건, 경로)** 세 요소인데 규칙은 사건만 봅니다. 빠진 것은 "경로" —
그 사건이 왜 이 종목인가. 그래서 지분 그래프(`kr_ownership_edges`)를 수집했고, 이유
생성기는 규칙 5종으로 만들되 **머신러닝은 학습셋이 쌓인 뒤**로 미뤘습니다.

한 가지 더: `classifyTheme`을 **문장에** 쓰면 안 됩니다. 그 규칙은 회사 이름용이라
"Tesla recalls vehicles over autopilot software"를 AI·소프트웨어로 분류합니다.

## 기술 스택

| 영역 | 사용 |
| --- | --- |
| 런타임 | Node.js 20+, ESM (`.mjs`) |
| HTTP | `node:http` — 프레임워크 없음 |
| 데이터베이스 | PostgreSQL 16 (Docker) |
| DB 드라이버 | `pg` 커넥션 풀 |
| 인증 | `node:crypto`로 HS256 토큰 검증 |
| 보안 | 허용목록 HTML sanitizer, 요청 검증, 매직바이트 업로드 판별 |
| 캐시 | TTL 캐시 + 동시 요청 병합, 토큰은 디스크에 보존 |
| 마이그레이션 | 순차 SQL 파일 |
| 테스트 | sanitizer 스위트 (`npm test`) |
| 분석 | Python 3.12, pandas·NumPy·SciPy·scikit-learn (읽기 전용) |

**Node 의존성은 `pg` 하나뿐입니다.** Express, ORM, JWT 라이브러리, sanitizer
라이브러리를 전부 표준 라이브러리 구현으로 대체했습니다.

## 구조

```text
src/
  server.mjs          라우팅, CORS, 오류 응답
  config.mjs          환경변수 로드
  collector.mjs       장중 수집 루프 — 세션별 케이던스, 전 종목 훑기
  http.mjs            timeout fetch, 응답 헬퍼
  cache.mjs           TTL 캐시 + 동시 요청 병합
  validate.mjs        요청 본문 검증
  auth/               서비스 간 토큰 검증, 호출자 신원 해석
  sanitize/           허용목록 HTML sanitizer
  db/                 pool, 사용자 provisioning, SQL
  pipeline/           시간별 스케줄러, 미국 일봉·분봉 백필
  routes/             app-data, market-board, media
  providers/
    kis toss market   시세·순위 (국내/해외)
    sec dart krx      공시·일정
    news              뉴스 수집과 정규화
    themes            테마 분류(큐레이션 + 네이버 사전 + 이름 규칙)
    naver-themes      네이버 테마 사전 크롤
    active-themes     그날 움직인 테마 — 뉴스 검색어의 출처
    pairing           짝꿍 후보 (1등주 → 따라갈 종목)
    theme-groups      세션별 짝꿍 패널 (정규장 / NXT 애프터)
    leadership        주도주 랭킹
    reasons catalyst  "왜 올랐나" 생성기
    ownership         타법인출자 지분 그래프
    investor-flow     개인·외국인·기관 순매수
    short-interest    미국 공매도 잔고 (격주)
    short-volume      미국 일별 공매도 거래량 (FINRA)
    premarket         미국 워치리스트와 장외 시세
    us-extended-leaders  열려 있는 미국 세션의 상승률
    us-etf            미국 ETF 목록
    symbol-news       종목별 뉴스에서 날짜 있는 예고 추출
analysis/             파이썬 학습 트랙 (읽기 전용)
scripts/              백필·점검·스냅샷 발행 (npm run 으로 호출)
db/migrations/        순차 SQL
```

## 실행

```powershell
Copy-Item .env.example .env
docker compose -f docker-compose.example.yml up -d postgres
npm install
npm run db:migrate
npm run db:check
npm run dev
```

기본 주소는 `http://localhost:4010`입니다.

## 엔드포인트

시장 보드:

- `GET /health`
- `GET /api/market-board`
- `GET /api/toss/leaders?market=KR` · `?market=US`
- `GET /api/toss/exchange-rate?baseCurrency=USD&quoteCurrency=KRW`

앱 데이터:

- `GET /api/me` · `PATCH /api/me/profile` · `POST /api/media`
- `GET|POST /api/community/posts` · `GET|PATCH /api/community/posts/:id`
- `GET|POST /api/community/posts/:id/comments`
- `PATCH|DELETE /api/community/comments/:id`
- `GET|POST /api/trade-journals` · `GET|PATCH /api/trade-journals/:id`
- `GET /api/me/community-posts` · `GET /api/me/trade-journals`

공개 목록 조회는 익명으로 되고, 나머지는 신원 없이 호출하면
`401 authentication_required`입니다. 비공개 매매 복기는 소유자가 아니면 보이지 않습니다.

## 환경변수

키가 없으면 해당 provider는 "사용 불가" 상태를 보고하고 나머지는 그대로 동작합니다.

- 토스: `TOSS_INVEST_CLIENT_ID`, `TOSS_INVEST_CLIENT_SECRET`
- KIS: `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_HTS_ID`(선택),
  `KIS_ENABLE_MINUTE_CHARTS`(선택, 기본 `false`)
- 그 외 provider 키와 SEC User-Agent는 `.env.example` 참고

`MARKET_DATA_MODE`는 기본이 `demo`이고, 이때는 키가 있어도 토스·KIS 시세가 공개
응답에서 차단됩니다. **시세 표시·재배포 권리가 확인된 환경에서만**
`licensed-live`로 바꾸세요.

`FRONTEND_ORIGIN`은 쉼표로 여러 오리진을 받습니다(로컬 + Vercel 도메인 등).

## 시장 보드 랭킹

거래대금은 **그날 누적 거래대금**(개장 이후 총액)이고, 이것이 국내 시장 화면이
보여주는 값입니다. 일부 서비스가 "실시간 거래대금"이라고 부르는 짧은 이동 구간
합계는 자릿수가 다르고 비교 대상이 아닙니다.

여기서 두 가지 랭킹이 나옵니다.

- **주도주** — 거래대금이 바닥이고, 여기에 상승과 자기 평소 대비 거래량 증가가
  더해집니다. 거래대금만 쓰면 매일 같은 대형주만 나열됩니다.
- **강세 테마** — 거래대금 가중 평균 등락률에 거래대금 하한을 겁니다. 총 거래대금으로
  테마를 세우면 대형주를 가진 섹터가 매번 1위입니다.

ETF·ETN·우선주·SPAC은 둘 다에서 제외합니다. ETF는 버리지 않고 **별도 목록**으로
내놓습니다 — 지수 펀드에는 테마가 없고, 거래대금을 테마에 합산하면 "누가 KODEX 200을
샀으니 반도체가 움직인다"가 됩니다.

미국 주도주는 야후 공개 스크리너에서 옵니다(키 불필요, 3개월 평균 거래량과 52주
신고가 포함). 토스가 담당했었지만 랭킹 엔드포인트가 계정 쿼터를 반환해서, 어댑터는
상태만 보고하고 보드는 의존하지 않습니다.

## 호출자 신원

`INTERNAL_JWT_SECRET`을 이 서버와 프론트에 **같은 값**으로 둡니다. 프론트가 요청마다
짧은 수명의 HS256 토큰을 서명해 `Authorization: Bearer`로 보내고, 서버가 서명·만료·
발급자·수신자를 확인한 뒤 `users` 행에 묶습니다.

시크릿이 설정되면 `X-Date-User-*` 헤더는 무시됩니다. 잘못되거나 만료된 토큰은
`401 invalid_internal_token`, 토큰이 없으면 익명으로 처리합니다.

시크릿이 없으면 헤더에서 신원을 읽는 모드로 떨어집니다(`X-Date-User-Provider`,
`-Id`, `-Name`, `-Email`). **누구나 그 헤더를 붙일 수 있으므로 로컬 전용**이고,
서버가 시작할 때 경고를 찍습니다.

## 요청 검증

모든 쓰기는 `경로 매칭 → 신원 확인 → 입력 검증 → sanitize → SQL` 순서를 지킵니다.
`src/validate.mjs`가 필드별로 검사하고 인식한 필드만 통과시켜서, 잘못된 요청이 DB
제약 위반의 `500`이 아니라 **필드 이름이 담긴 `400`**으로 답합니다.

PATCH 검증기는 부분 모드로 돌아 없는 필드를 없는 채로 두고, 저장소의 `COALESCE`가
기존 값을 유지합니다. 상세 응답에는 `is_owner`가 들어가므로 클라이언트가 작성자
id를 다시 만들어 비교할 필요가 없습니다.

## 리치 텍스트 sanitize

커뮤니티 본문과 매매 복기는 contenteditable 에디터에서 오므로 붙여넣은 무엇이든
들어올 수 있습니다. `src/sanitize/html.mjs`가 그 HTML을 파싱해 **허용목록으로 다시
직렬화**합니다. 텍스트는 이스케이프하고, 아는 태그·속성만 다시 내보냅니다. 모르는
태그는 벗겨내고, `script`·`style`·`iframe`·`svg`·`form` 부류는 자식까지 버리며,
`href`·`src`는 안전한 URL 패턴이어야 합니다.

sanitize는 **쓸 때와 읽을 때 모두** 돌아서, 이 코드가 생기기 전에 저장된 행도 나가는
길에 정리됩니다.

```powershell
npm test
```

`POST /api/media`는 `multipart/form-data`를 받습니다 — `file`(이미지, 5MB 이하),
`usageType`(`profile` · `community` · `trade-journal`). 업로드는 `UPLOAD_DIR` 아래
저장되고 `/uploads/:storageKey`로 서빙됩니다. 프로덕션에서는 같은 응답 모양을
유지한 채 S3·R2·NAS 구현으로 바꾸면 됩니다.

## 배포

현재 모양:

```text
Vercel 프론트 ─┬─→ (로컬) 백엔드 :4010 ─→ provider들
               └─→ (공개) 보드 스냅샷 JSON
```

수집기는 데스크톱에서 돌고, 배포된 프론트는 백엔드에 닿지 못할 때 공개 스냅샷을
읽습니다. provider 시크릿은 백엔드 환경에만 둡니다.

서버로 올릴 때:

```powershell
docker build -t date-platform-backend .
docker run --env-file .env -p 4010:4010 date-platform-backend
```

```powershell
Copy-Item docker-compose.example.yml docker-compose.yml
docker compose up -d
```

EC2·Lightsail이면 Docker 또는 Node + systemd, DB는 RDS로 `DATABASE_URL`만 바꾸면
됩니다. NAS면 리버스 프록시 뒤에 compose로 올리고, 프론트에는
`DATE_BACKEND_URL=https://api.example.com` 식으로 지정합니다.
