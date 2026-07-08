# FOCAS Lead Server

Zero-dependency Node server that captures leads from the FOCAS Edu website forms,
inserts them into **Zoho Bigin** (Contacts), and forwards the full details + UTM
params to an external leads API. It can also serve the built website so
everything runs on **one port**.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/counseling` | Student Registration form (`/focas`) |
| POST | `/api/workout-batch` | Workout Batch enrol form (`/workout-batch`) |
| GET | `/health` | Health check → `{ ok: true }` |
| GET | `*` | Serves the built website (SPA) from `FRONTEND_DIST` |

Both form endpoints share one pipeline: **rate limit → honeypot → Bigin insert →
leads-API forward**. They differ only in the values below.

## Request body (from the forms)

```json
{
  "firstName": "Arjun",
  "lastName": "Kumar",
  "phone": "+919812345670",
  "caStatus": "Intermediate",
  "attempt": "May 2026",          // counseling only
  "language": "Tamil",            // counseling only
  "city": "Coimbatore",
  "state": "Tamil Nadu",
  "company": "",                  // honeypot — must be empty
  "utm": {
    "utmSource": "google", "utmMedium": "cpc", "utmCampaign": "...",
    "utmContent": "...", "utmTerm": "...", "landingUrl": "...", "referrer": "..."
  }
}
```

## Field mapping → Bigin Contacts

| Form field | Bigin API field | Notes |
|------------|-----------------|-------|
| firstName | `First_Name` | |
| lastName | `Last_Name` | required |
| phone | `Phone` | `+91` + number, no space |
| caStatus | `CA_Status` | |
| attempt | `Attempt` | counseling only |
| language | `Language` | counseling only |
| city + state | `Other_City` | stored as `"City, State"` (no State field in Bigin) |
| — | `Lead_Source1` | fixed per form (see below) |

UTM params are **never** written to Bigin — they only go to the leads API.

## Per-form config

| Endpoint | `Lead_Source1` (Bigin) | `source` (leads API) |
|----------|------------------------|----------------------|
| `/api/counseling` | `Student Registration` | `counseling-form` |
| `/api/workout-batch` | `Hindi WB` | `workout-batch` |

## Leads API forward

Every accepted lead is POSTed to `LEADS_API_URL` (`/api/leads/web`) with all form
fields, all UTM params, the `biginContactId`, and a `source` tag. Best-effort:
if it fails, the Bigin insert still succeeds.

## Configuration (`.env`)

See `.env.example`. Key vars:

- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` / `ZOHO_REGION`
- `PORT` (default 8080)
- `FRONTEND_DIST` — absolute path to the website's built `dist/` (for single-port serving)
- `LEADS_API_URL` — external leads endpoint
- `COUNSELING_RATE_MAX` / `COUNSELING_RATE_WINDOW_MS` — per-IP rate limit
- `COUNSELING_TRUST_PROXY` — trust `X-Forwarded-For` (behind ngrok / reverse proxy)
- `COUNSELING_ALLOWED_ORIGINS` — CORS allow-list (only needed if site is on another origin)

## Running

**Single port (site + API):**
```bash
# 1) build the website
cd /home/sandy/Downloads/FOCAS-Edu-Website-main && npm run build
# 2) run this server (serves that dist + API on PORT)
cd /home/sandy/Downloads/focas-lead-server && npm start
# → http://localhost:8080
```

**Dev with hot-reload (API on :7001, website via `vite`):**
```bash
cd /home/sandy/Downloads/focas-lead-server && npm run server:dev   # API :7001
cd /home/sandy/Downloads/FOCAS-Edu-Website-main && npm run dev      # site :8080 (proxies /api → :7001)
```

## Notes

- Needs **Node 18+** (built-in `fetch`). No `npm install` required.
- New contacts may be auto-assigned to another Bigin user by an assignment rule.
- Free **ngrok** URLs change on restart — update `LEADS_API_URL` and restart.
