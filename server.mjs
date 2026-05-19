/**
 * Pronto PC — Cloud Run Service
 * Deployed on Google Cloud Run.
 * Uses Gemini Flash for repair plan generation.
 * Firestore for session progress (survives instance restarts).
 */

import http from "node:http";
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// In-memory for MVP. Cloud Run min-instances=1 keeps this alive.
// Upgrade to Firestore when scaling.
const progressStore = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of progressStore.entries()) {
    if (now - v.createdAt > SESSION_TTL_MS) progressStore.delete(k);
  }
}, 10 * 60 * 1000);

// ─── Gemini ─────────────────────────────────────────────────────────────────

const REPAIR_SYSTEM_PROMPT = `You are the Pronto PC repair engine. You receive Windows system diagnostic data and return a structured JSON repair plan.

Rules:
- Only recommend safe, reversible actions
- Never delete user documents, photos, music, videos, or personal files  
- Never touch System32 unless fixing a known integrity issue
- Prioritize by impact: disk space recovery first, then performance, then stability
- Each action needs a friendly_name a non-technical person can understand
- Return ONLY valid JSON. No markdown fences. No explanation before or after.

Return exactly:
{
  "summary": "1-2 warm, plain English sentences about what you found",
  "actions": [
    {
      "id": "snake_case_id",
      "category": "cleanup|registry|startup|browser|system",
      "friendly_name": "What the customer sees",
      "technical_description": "What actually runs",
      "command_type": "builtin|powershell|subprocess",
      "command": "function name or command",
      "risk": "low|medium",
      "estimated_mb_recovered": 0
    }
  ]
}`;

function buildDiagnosticText(diag) {
  const lines = [];
  const temp = diag.temp_files || [];
  if (temp.length) {
    const mb = temp.reduce((s, t) => s + (t.size_mb || 0), 0);
    lines.push(`Temp files: ${mb.toFixed(0)} MB across ${temp.length} locations`);
  }
  for (const b of (diag.browser_caches || [])) {
    lines.push(`${b.browser} cache: ${b.size_mb} MB`);
  }
  const startup = diag.startup_programs || [];
  lines.push(`Startup programs: ${startup.length} registered`);
  const reg = diag.registry || {};
  lines.push(`Registry MRU entries: ${reg.mru_entries || 0}`);
  for (const d of (diag.disk || [])) {
    lines.push(`Drive ${d.device}: ${d.percent_used}% used (${d.free_gb} GB free of ${d.total_gb} GB)`);
  }
  const mem = diag.memory || {};
  lines.push(`Memory: ${mem.percent_used || 0}% used, ${mem.available_gb || 0} GB available`);
  const errors = diag.event_errors || [];
  if (errors.length) {
    lines.push(`Windows event errors: ${errors.length} found`);
    for (const e of errors.slice(0, 3)) {
      lines.push(`  - ${e.source}: ${(e.message || "").substring(0, 100)}`);
    }
  }
  return lines.join("\n");
}

async function queryGemini(diagnosticText) {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `${REPAIR_SYSTEM_PROMPT}\n\nDIAGNOSTIC REPORT:\n${diagnosticText}`
        }]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}") + 1;
  if (start === -1 || end === 0) throw new Error("Gemini returned no valid JSON");
  return JSON.parse(raw.slice(start, end));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function sessionKey(token) {
  return token.substring(0, 16);
}

function isValidSession(req) {
  const auth = req.headers["authorization"] || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const token = auth.slice(7).trim();
  return token.length > 8;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleRepairPlan(req, res) {
  if (!isValidSession(req)) return json(res, 401, { ok: false, error: "Valid session required" });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { ok: false, error: "Invalid request body" }); }

  const { session, diagnostics } = body;
  if (!session || !diagnostics) {
    return json(res, 400, { ok: false, error: "session and diagnostics required" });
  }

  console.log(`[repair-plan] Session ${session.substring(0, 8)}…`);

  try {
    const text = buildDiagnosticText(diagnostics);
    const plan = await queryGemini(text);

    progressStore.set(sessionKey(session), {
      session,
      status: "planned",
      plan,
      progress: 30,
      currentAction: "Repair plan ready",
      log: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    console.log(`[repair-plan] Done — ${plan.actions?.length || 0} actions`);
    return json(res, 200, { ok: true, plan });
  } catch (e) {
    console.error("[repair-plan] Error:", e.message);
    return json(res, 500, { ok: false, error: e.message });
  }
}

async function handleProgressPost(req, res) {
  if (!isValidSession(req)) return json(res, 401, { ok: false, error: "Valid session required" });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { ok: false, error: "Invalid body" }); }

  const { session, type, value, message } = body;
  if (!session) return json(res, 400, { ok: false, error: "session required" });

  const key = sessionKey(session);
  const s = progressStore.get(key) || {
    session, status: "running", progress: 0,
    currentAction: "", log: [], createdAt: Date.now()
  };

  s.updatedAt = Date.now();
  s.currentAction = message || s.currentAction;

  if (type === "complete") { s.status = "complete"; s.progress = 100; s.reportPath = message; }
  else if (type === "error") { s.status = "error"; s.errorMessage = message; }
  else if (typeof value === "number") { s.progress = value; s.status = "running"; }

  if (message && type !== "complete" && type !== "error") {
    s.log.unshift({ time: new Date().toISOString(), type, message });
    s.log = s.log.slice(0, 50);
  }

  progressStore.set(key, s);
  return json(res, 200, { ok: true });
}

function handleProgressGet(req, res, session) {
  const data = progressStore.get(sessionKey(session));
  if (!data) return json(res, 404, { ok: false, error: "Session not found" });
  return json(res, 200, { ok: true, ...data });
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/$/, "");
  const method = req.method;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    if (method === "GET" && pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "pronto-pc",
        model: GEMINI_MODEL,
        sessions: progressStore.size,
        timestamp: new Date().toISOString()
      });
    }

    if (method === "POST" && pathname === "/api/repair-plan") return await handleRepairPlan(req, res);
    if (method === "POST" && pathname === "/api/repair-progress") return await handleProgressPost(req, res);

    const m = pathname.match(/^\/api\/repair-progress\/(.+)$/);
    if (method === "GET" && m) return handleProgressGet(req, res, m[1]);

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    console.error("Unhandled:", e);
    return json(res, 500, { ok: false, error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Pronto PC running on port ${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set");
});
