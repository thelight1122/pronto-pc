/**
 * Pronto PC — Cloud Run Service
 * Deployed on Google Cloud Run.
 * Uses Gemini Flash for repair plan generation.
 * Firestore for session progress (survives instance restarts).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL     = process.env.FROM_EMAIL    || "support@prontopc.online";
const DOWNLOAD_URL   = process.env.DOWNLOAD_URL  || "https://prontopc.online/download/pronto-agent.py";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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

const REPAIR_SYSTEM_PROMPT = `CRITICAL: Your entire response must be a single JSON object. No text before it. No text after it. No markdown. No explanation. Start with { and end with }.

You are the Pronto PC repair engine. You receive Windows system diagnostic data and return a structured JSON repair plan.

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
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json" }
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  console.log("[gemini-raw]", JSON.stringify(raw).substring(0, 500));
  console.log("[gemini-finish]", data.candidates?.[0]?.finishReason);
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}") + 1;
  if (start === -1 || end === 0) {
    console.log("[gemini-full]", JSON.stringify(data).substring(0, 1000));
    throw new Error("Gemini returned no valid JSON");
  }
  return JSON.parse(cleaned.slice(start, end));
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


// ─── Stripe webhook ───────────────────────────────────────────────────────────

const stripeClient = STRIPE_WEBHOOK_SECRET ? new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2024-04-10" }) : null;

async function sendDeliveryEmail(customerEmail, customerName) {
  const displayName = customerName || "there";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#FDFAF4;margin:0;padding:0}
.wrap{max-width:580px;margin:40px auto;background:#fff;border:1px solid #E2DBD0;border-radius:12px;overflow:hidden}
.header{background:#C8892A;padding:28px 36px}
.header h1{font-family:Georgia,serif;color:#fff;margin:0;font-size:1.5rem;font-weight:700;letter-spacing:-0.3px}
.header p{color:rgba(255,255,255,.85);margin:4px 0 0;font-size:.9rem}
.body{padding:32px 36px}
.body p{color:#3A3835;font-size:.97rem;line-height:1.7;margin:0 0 16px}
.body strong{color:#1A1917}
.btn-wrap{text-align:center;margin:28px 0}
.btn{display:inline-block;background:#C8892A;color:#fff;text-decoration:none;font-weight:600;font-size:1rem;padding:14px 36px;border-radius:10px;letter-spacing:-.2px}
.steps{background:#F5F0E8;border-radius:8px;padding:20px 24px;margin:20px 0}
.steps h3{font-size:.85rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#6B6560;margin:0 0 12px}
.step{display:flex;align-items:flex-start;gap:12px;margin-bottom:10px}
.step-num{width:22px;height:22px;border-radius:50%;background:#C8892A;color:#fff;font-size:.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step p{margin:0;font-size:.88rem;color:#3A3835;line-height:1.5}
.footer{border-top:1px solid #E2DBD0;padding:20px 36px;text-align:center}
.footer p{font-size:.78rem;color:#9B9590;margin:0;line-height:1.6}
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <h1>Pronto PC — You're all set.</h1>
    <p>Your payment is confirmed. Your repair is ready to run.</p>
  </div>
  <div class="body">
    <p>Hi ${displayName},</p>
    <p>Thank you for choosing Pronto PC. Your $39 payment has been confirmed and your repair agent is ready to download.</p>
    <div class="btn-wrap">
      <a href="${DOWNLOAD_URL}" class="btn">Download Pronto PC Agent →</a>
    </div>
    <div class="steps">
      <h3>What happens next</h3>
      <div class="step"><div class="step-num">1</div><p><strong>Download and run</strong> the agent on the Windows PC you want repaired.</p></div>
      <div class="step"><div class="step-num">2</div><p><strong>The agent scans</strong> your system and sends your diagnostic data to our AI engine.</p></div>
      <div class="step"><div class="step-num">3</div><p><strong>We show you</strong> exactly what we found and what we'll fix before anything changes.</p></div>
      <div class="step"><div class="step-num">4</div><p><strong>Repairs run</strong> automatically. A full audit report is saved to your Desktop when done.</p></div>
    </div>
    <p>If we detect any hardware issues during your scan, you will also receive a <strong>Hardware Findings Report</strong> formatted for a technician — at no extra charge.</p>
    <p>Your download link is valid for 30 days. If you have any trouble, reply to this email or contact <a href="mailto:support@prontopc.online" style="color:#C8892A">support@prontopc.online</a>.</p>
    <p>— The Pronto PC Team<br><span style="color:#6B6560;font-size:.88rem">5D Service Solutions Global LLC · Lake Havasu City, AZ</span></p>
  </div>
  <div class="footer">
    <p>This is a transactional email confirming your purchase.<br>Pronto PC · prontopc.online · support@prontopc.online</p>
  </div>
</div>
</body></html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `Pronto PC <${FROM_EMAIL}>`,
      to: [customerEmail],
      subject: "Your Pronto PC repair agent is ready to download",
      html
    })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Resend API error");
  console.log(`[webhook] Delivery email sent to ${customerEmail} via Resend — id: ${result.id}`);
}

async function handleStripeWebhook(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const sig = req.headers["stripe-signature"] || "";

  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const stripe = new Stripe("", { apiVersion: "2024-04-10" });
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(rawBody.toString("utf8"));
    }
  } catch (err) {
    console.warn("[webhook] Verification failed:", err.message);
    return json(res, 400, { ok: false, error: "Invalid signature" });
  }

  console.log(`[webhook] Event: ${event.type}`);

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    const email = session?.customer_details?.email || session?.customer_email;
    const name  = session?.customer_details?.name  || "";
    const paid  = session?.payment_status === "paid";

    if (email && paid) {
      try {
        await sendDeliveryEmail(email, name);
      } catch (e) {
        console.error("[webhook] Email failed:", e.message);
        // Don't return error — Stripe would retry. Log and continue.
      }
    } else {
      console.warn(`[webhook] Skipped email — email: ${email}, paid: ${paid}`);
    }
  }

  return json(res, 200, { ok: true, received: true });
}

function serveHtml(res, filename) {
  const filePath = path.join(__dirname, filename);
  try {
    const html = fs.readFileSync(filePath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Page not found");
  }
}
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

    if (method === "GET" && pathname === "/test-email") {
      try {
        await sendDeliveryEmail(SMTP_USER, "Tracey");
        return json(res, 200, { ok: true, message: "Test email sent to " + SMTP_USER });
      } catch(e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (method === "POST" && pathname === "/webhook") return await handleStripeWebhook(req, res);
    if (method === "GET" && pathname === "/terms") return serveHtml(res, "terms.html");
    if (method === "GET" && pathname === "/report") return serveHtml(res, "confirm.html");
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
