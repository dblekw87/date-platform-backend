# date-platform-backend

API server for [DATE](https://github.com/dblekw87/date-platform), a trading community platform.

It owns every external data provider, the application database, and the API the
Next.js frontend reads. Provider credentials never reach a browser-facing
process.

## Tech Stack

| Area | Stack |
| --- | --- |
| Runtime | Node.js 20+, ESM (`.mjs`) |
| HTTP | `node:http` — no framework |
| Database | PostgreSQL 16 (Docker) |
| DB driver | `pg` connection pool |
| Auth | HS256 token verification with `node:crypto` |
| Security | Allowlist HTML sanitizer, request validation, magic-byte upload typing |
| Caching | In-memory TTL cache with in-flight de-duplication, tokens persisted to disk |
| Migrations | Sequential SQL files |
| Testing | Sanitizer suite (`npm test`) |

**The only dependency is `pg`.** Express, an ORM, a JWT library, and a sanitizer
library are all replaced by standard-library implementations.

## Layout

```text
src/
  server.mjs          라우팅, CORS, 오류 응답
  config.mjs          환경변수 로드
  http.mjs            timeout fetch, 응답 헬퍼
  cache.mjs           TTL 캐시 + 동시 요청 병합
  validate.mjs        요청 본문 검증
  auth/               서비스 간 토큰 검증, 호출자 신원 해석
  sanitize/           허용목록 HTML sanitizer
  db/                 pool, 사용자 provisioning, SQL
  routes/             app-data, market-board, media
  providers/          kis, toss, market, sec, dart, krx, news
                      themes(테마 분류), format(금액 표기)
                      token-store(토큰 보존), runtime-state(신규 판정)
```

## Run

```powershell
Copy-Item .env.example .env
npm run dev
```

Default server URL:

```text
http://localhost:4010
```

## Endpoints

- `GET /health`
- `GET /api/market-board`
- `GET /api/toss/leaders?market=KR`
- `GET /api/toss/leaders?market=US`
- `GET /api/toss/exchange-rate?baseCurrency=USD&quoteCurrency=KRW`

## Environment

Toss endpoints return an unavailable provider status until these are set:

- `TOSS_INVEST_CLIENT_ID`
- `TOSS_INVEST_CLIENT_SECRET`

KIS market-board data returns an unavailable provider status until these are set:

- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `KIS_HTS_ID` optional
- `KIS_ENABLE_MINUTE_CHARTS` optional, defaults to `false`

`MARKET_DATA_MODE` defaults to `demo`, which blocks Toss/KIS live data from the public market-board response even when keys are present. Set `MARKET_DATA_MODE=licensed-live` only after the required market-data display and redistribution rights are cleared for the target environment.

## Market board ranking

Turnover figures are the **day's accumulated trading value** (총 거래대금 since the
open), which is what domestic market screens report. Some services label a
short rolling window as "실시간 거래대금"; those numbers are an order of magnitude
smaller and are not comparable.

Two rankings are derived from it:

- **주도주** — turnover is the base, then a rising price and volume running above
  the stock's own normal add to the score. Turnover alone would list the same
  mega caps every session.
- **강세 테마** — turnover-weighted average change rate, with a turnover floor.
  Ranking themes by total turnover just re-lists whichever sector holds the
  largest caps.

ETFs, ETNs, preferred shares, and SPACs are excluded from both.

US leaders come from the public Yahoo Finance screener, which needs no key and
carries the three-month average volume and 52-week high the ranking uses. Toss
supplied them previously but its ranking endpoint returns a quota error; the
adapter stays registered and reports its status, and the board no longer depends
on it. Domestic leaders come from KIS and the exchange rate from Frankfurter, so
nothing else is lost while Toss is unavailable.

The frontend should call this backend instead of calling Toss or KIS directly.

`FRONTEND_ORIGIN` can contain multiple comma-separated origins, for example local development plus a Vercel domain.

PostgreSQL is the application database. Local development can use the PostgreSQL service in `docker-compose.example.yml`.

```powershell
Copy-Item .env.example .env
docker compose -f docker-compose.example.yml up -d postgres
npm install
npm run db:migrate
npm run db:check
npm run dev
```

## Caller identity

Set `INTERNAL_JWT_SECRET` to the same value on this server and on the frontend. The frontend then signs a short-lived HS256 token per request and sends it as `Authorization: Bearer <token>`, and this server verifies the signature, expiry, issuer, and audience before binding data to a `users` row.

With the secret set, the `X-Date-User-*` headers are ignored. Requests with a bad or expired token get `401 invalid_internal_token`; requests with no token are treated as anonymous.

Without the secret the server falls back to reading identity from these headers:

- `X-Date-User-Provider`
- `X-Date-User-Id`
- `X-Date-User-Name`
- `X-Date-User-Email` optional

Any client can set those headers, so the fallback is for local development only. The server prints a warning at startup when it is active.

Reads of public collections (`GET /api/community/posts`, `GET /api/trade-journals`, and their detail routes) work anonymously. Every other endpoint returns `401 authentication_required` without an identity. Private trade journals stay hidden from anonymous and non-owner callers.

Core app endpoints:

- `GET /api/me`
- `PATCH /api/me/profile`
- `POST /api/media`
- `GET /api/community/posts?limit=20&cursor=...&category=...&q=...`
- `POST /api/community/posts`
- `GET /api/community/posts/:id`
- `PATCH /api/community/posts/:id`
- `GET /api/community/posts/:id/comments`
- `POST /api/community/posts/:id/comments`
- `PATCH /api/community/comments/:id`
- `DELETE /api/community/comments/:id`
- `GET /api/me/community-posts`
- `GET /api/trade-journals?limit=20&cursor=...`
- `POST /api/trade-journals`
- `GET /api/trade-journals/:id`
- `PATCH /api/trade-journals/:id`
- `GET /api/me/trade-journals`

## Request validation

Writes run `path match → identity → validation → sanitize → SQL`. `src/validate.mjs`
checks each field and passes through only the ones it recognizes, so a bad request
answers `400` naming the field instead of surfacing a database constraint as a
`500`. PATCH validators run in partial mode, leaving absent fields absent so the
repository's `COALESCE` keeps the stored value.

Detail responses include `is_owner`, computed from the viewer's row, so clients do
not rebuild an author id to decide whether to offer editing.

## Rich text sanitizing

Community post bodies and trade journal sections come from a contenteditable editor, so they can contain anything the author pasted. `src/sanitize/html.mjs` parses that HTML and re-serializes it from an allowlist: text is escaped, and only known tags and attributes are re-emitted. Unknown tags are unwrapped, `script`/`style`/`iframe`/`svg`/`form` and friends are dropped with their children, and `href`/`src` must match a safe-URL pattern.

Sanitizing runs when a post or journal is written, and again when a detail route reads one, so rows stored before this existed are also cleaned on the way out.

Run the sanitizer test suite with:

```powershell
npm test
```

`POST /api/media` accepts `multipart/form-data`:

- `file`: image file, up to 5 MB
- `usageType`: `profile`, `community`, or `trade-journal`

Uploaded files are stored under `UPLOAD_DIR` and served from `/uploads/:storageKey`. For production, replace the local disk implementation with S3, Cloudflare R2, or NAS-backed storage while keeping the same API response shape.

## Vercel now, AWS/NAS later

Current recommended development shape:

```text
Vercel frontend -> HTTPS backend domain -> Toss/KIS/DART/SEC providers
```

Keep provider secrets only in the backend environment. Do not expose Toss or KIS credentials to Vercel client code.

Later deployment options:

- AWS EC2 or Lightsail: run this server with Docker or Node + systemd.
- AWS RDS PostgreSQL: set `DATABASE_URL` to the RDS connection string.
- NAS: run this server with Docker Compose behind a reverse proxy, with PostgreSQL either in the same compose stack or as a managed NAS package.
- Domain: point an API subdomain such as `api.example.com` to the backend, then set frontend env like `DATE_BACKEND_URL=https://api.example.com`.

## Docker

```powershell
docker build -t date-platform-backend .
docker run --env-file .env -p 4010:4010 date-platform-backend
```

For NAS or EC2 compose deployment:

```powershell
Copy-Item docker-compose.example.yml docker-compose.yml
docker compose up -d
```
