# date-platform-backend

Node.js backend for DATE market/community services.

This server keeps provider credentials such as Toss Invest API keys outside the Next.js frontend and exposes normalized internal APIs for the frontend.

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

The frontend should call this backend instead of calling Toss directly.

PostgreSQL is the application database. Local development can use the PostgreSQL service in `docker-compose.example.yml`.

```powershell
Copy-Item .env.example .env
docker compose -f docker-compose.example.yml up -d postgres
npm install
npm run db:migrate
npm run dev
```

Application data endpoints currently use a mock authenticated user (`date_user`) until OAuth/JWT is connected.

Core app endpoints:

- `GET /api/me`
- `PATCH /api/me/profile`
- `GET /api/community/posts?limit=20&cursor=...`
- `POST /api/community/posts`
- `GET /api/community/posts/:id`
- `PATCH /api/community/posts/:id`
- `GET /api/me/community-posts`
- `GET /api/trade-journals?limit=20&cursor=...`
- `POST /api/trade-journals`
- `GET /api/trade-journals/:id`
- `PATCH /api/trade-journals/:id`
- `GET /api/me/trade-journals`

## Vercel now, AWS/NAS later

Current recommended development shape:

```text
Vercel frontend -> HTTPS backend domain -> Toss/KIS/DART/SEC providers
```

Keep provider secrets only in the backend environment. Do not expose Toss credentials to Vercel client code.

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
