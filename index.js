// Zero-dependency Bigin lead server for the FOCAS Edu website.
//
// The frontend cannot call Bigin directly (the refresh token would be exposed
// and Bigin blocks browser CORS), so this small Node service holds the Zoho
// credentials, exchanges the refresh token for a short-lived access token
// (cached in memory), and inserts a Contact via the Bigin REST API.
//
// It also (single-port) serves the built frontend from FRONTEND_DIST so the
// whole site + API run on one port.
//
// Run:  npm start            (serves site + API on PORT, default 8080)
//       npm run server:dev   (API only on :7001, for `vite` dev proxy)
// Needs Node 18+ (uses the built-in global fetch). No npm install required.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env from this folder (simple parser; does not overwrite real env) ──
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* no .env file — rely on real environment */
  }
}
loadEnv();

const CLIENT_ID = process.env.ZOHO_CLIENT_ID || process.env.OHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const REGION = (process.env.ZOHO_REGION || "in").toLowerCase();
const PORT = Number(process.env.PORT || process.env.COUNSELING_PORT || 8080);
const ALLOWED = (process.env.COUNSELING_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// External leads API — receives the full student details + UTM params.
// (UTMs are deliberately NOT written to Bigin.)
const LEADS_API_URL = process.env.LEADS_API_URL || "";
// Rate limit: max submissions per IP within the window (defaults: 5 / 10 min).
const RATE_MAX = Number(process.env.COUNSELING_RATE_MAX || 5);
const RATE_WINDOW_MS = Number(process.env.COUNSELING_RATE_WINDOW_MS || 10 * 60 * 1000);
// If true, trust X-Forwarded-For (set when running behind ngrok / a reverse proxy).
const TRUST_PROXY = String(process.env.COUNSELING_TRUST_PROXY || "true") === "true";

// Built frontend to serve (single-port). Point FRONTEND_DIST at the website's
// dist/ folder; falls back to a local ./dist copy if present.
const DIST_DIR = process.env.FRONTEND_DIST
  ? resolve(process.env.FRONTEND_DIST)
  : join(__dirname, "dist");

// Zoho DC hosts. `.in` for India; falls back sensibly for others.
const ACCOUNTS_HOST = `https://accounts.zoho.${REGION}`;
const API_HOST = `https://www.zohoapis.${REGION}`;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error(
    "[leads] Missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN in .env"
  );
  process.exit(1);
}

// ── Access-token cache ──
let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.value;
  }
  const body = new URLSearchParams({
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("token refresh failed: " + JSON.stringify(data));
  }
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return tokenCache.value;
}

// Today's date in Asia/Kolkata (IST) as "YYYY-MM-DD" for Bigin date fields.
function todayIST() {
  // en-CA formats as YYYY-MM-DD; the timeZone pins it to the Indian calendar day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ── Build the Bigin Contact from the form payload ──
// leadSource sets Lead_Source1 (e.g. "Student Registration", "Hindi WB").
function buildContact(b, leadSource = "Student Registration") {
  const first = String(b.firstName || "").trim();
  const last = String(b.lastName || "").trim();
  const phone = String(b.phone || "").trim();
  const caStatus = String(b.caStatus || "").trim();
  const attempt = String(b.attempt || "").trim();
  const city = String(b.city || "").trim();
  const state = String(b.state || "").trim();
  const language = String(b.language || "").trim();

  if (!last) throw { status: 400, message: "Last name is required." };

  // No State field exists in Bigin Contacts → fold into City ("City, State").
  const otherCity = [city, state].filter(Boolean).join(", ");

  const rec = {
    Last_Name: last,
    Phone: phone,
    CA_Status: caStatus,
    Attempt: attempt,
    Other_City: otherCity,
    Language: language,
    Lead_Source1: leadSource,
    // Stamp today's date (IST) on every submission. On an upsert-update this
    // refreshes the referral date of the existing contact to today.
    Referral_date: todayIST(),
  };
  if (first) rec.First_Name = first;
  return rec;
}

// Forward the full lead (student details + UTMs) to the external leads API.
// Best-effort: never blocks or fails the Bigin insert.
async function forwardLead(body, biginId, source = "counseling-form") {
  if (!LEADS_API_URL) return;
  const u = body.utm || {};
  const payload = {
    name: [body.firstName, body.lastName].filter(Boolean).join(" ").trim(),
    firstName: body.firstName || "",
    lastName: body.lastName || "",
    phone: body.phone || "",
    email: body.email || "",
    caStatus: body.caStatus || "",
    attempt: body.attempt || "",
    city: body.city || "",
    state: body.state || "",
    language: body.language || "",
    utmSource: u.utmSource || "",
    utmMedium: u.utmMedium || "",
    utmCampaign: u.utmCampaign || "",
    utmContent: u.utmContent || "",
    utmTerm: u.utmTerm || "",
    landingUrl: u.landingUrl || "",
    referrer: u.referrer || "",
    biginContactId: biginId || "",
    source,
  };
  try {
    const res = await fetch(LEADS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Skip ngrok's browser-warning interstitial for API calls.
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(payload),
    });
    console.log(`[leads] leads API forward → ${res.status}`);
  } catch (err) {
    console.error("[leads] leads API forward failed:", err?.message || err);
  }
}

// Upsert the Contact: if a Contact with the same Phone already exists, Bigin
// updates it (merging the new field values) instead of failing with
// DUPLICATE_DATA; otherwise it inserts a new one. `duplicate_check_fields`
// tells Bigin which field(s) identify an existing record.
async function insertContact(record) {
  const token = await getAccessToken();
  const res = await fetch(`${API_HOST}/bigin/v2/Contacts/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: [record],
      duplicate_check_fields: ["Phone"],
      trigger: ["workflow"],
    }),
  });
  const data = await res.json();
  const row = data?.data?.[0];
  if (row?.code !== "SUCCESS") {
    throw { status: 502, message: row?.message || "Bigin rejected the record", detail: data };
  }
  // row.action is "insert" or "update".
  return { id: row.details?.id, action: row.action };
}

// ── Rate limiting (in-memory, per-IP sliding window) ──
const rateHits = new Map(); // ip -> number[] of request timestamps

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

// Returns true if the request is allowed; false if the IP is over the limit.
function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(ip, hits);
  return true;
}

// Occasionally prune stale IPs so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateHits) {
    const fresh = hits.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length) rateHits.set(ip, fresh);
    else rateHits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// ── CORS ──
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED.length === 0 || ALLOWED.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (ALLOWED.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// ── Static frontend (the built Vite app) ──
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req, res) {
  // Resolve the request path safely inside DIST_DIR (block traversal).
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const safePath = normalize(join(DIST_DIR, urlPath));
  const isInside = safePath.startsWith(DIST_DIR);

  try {
    if (!isInside || urlPath === "/" || urlPath.endsWith("/")) throw 0;
    const data = await readFile(safePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(safePath).toLowerCase()] || "application/octet-stream",
    });
    return res.end(data);
  } catch {
    // SPA fallback: any unknown route → index.html (React Router handles it).
    try {
      const html = await readFile(join(DIST_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end(
        "Frontend build not found. Build the website and set FRONTEND_DIST to its dist/ folder."
      );
    }
  }
}

const server = http.createServer((req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  // Both lead forms share the same pipeline; they differ only in the Lead
  // Source written to Bigin and the "source" tag sent to the leads API.
  const FORMS = {
    "/api/counseling": { leadSource: "Student Registration", source: "counseling-form" },
    "/api/workout-batch": { leadSource: "Hindi WB", source: "workout-batch" },
  };

  if (req.method === "POST" && FORMS[req.url]) {
    const cfg = FORMS[req.url];
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      console.warn(`[leads] rate limited: ${ip}`);
      return sendJson(res, 429, {
        ok: false,
        error: "Too many submissions. Please try again in a few minutes.",
      });
    }

    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on("end", async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};

        // Honeypot: real users leave this empty; bots fill it. Pretend success
        // so bots don't learn they were blocked, but skip Bigin + leads API.
        if (body.company && String(body.company).trim()) {
          console.warn(`[leads] honeypot triggered: ${ip}`);
          return sendJson(res, 200, { ok: true });
        }

        const record = buildContact(body, cfg.leadSource);
        const { id, action } = await insertContact(record);
        console.log(`[leads] contact ${action}d: ${id} (${cfg.source})`);
        // Forward student details + UTMs to the leads API (best-effort).
        await forwardLead(body, id, cfg.source);
        sendJson(res, 200, { ok: true, id });
      } catch (err) {
        const status = err?.status || 500;
        console.error("[leads] error:", err?.message || err, err?.detail || "");
        sendJson(res, status, { ok: false, error: err?.message || "Server error" });
      }
    });
    return;
  }

  // Anything else that's a GET → serve the built frontend (single-port setup).
  if (req.method === "GET") return serveStatic(req, res);

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[leads] server (site + API) listening on http://localhost:${PORT}`);
  console.log(`[leads] Zoho DC: ${API_HOST}`);
  console.log(`[leads] serving frontend from: ${DIST_DIR}`);
  if (!existsSync(DIST_DIR)) {
    console.warn("[leads] FRONTEND_DIST not found — build the website and set FRONTEND_DIST.");
  }
});
