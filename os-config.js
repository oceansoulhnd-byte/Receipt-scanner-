/* ============================================================
   os-config.js — Ocean Soul A11S shared mobile-tool config
   ============================================================
   Single source of truth for the Anthropic model name used by
   receipt_scanner.html and invoice_check.html, so a future model
   retirement only needs ONE fix instead of one per tool.

   Load this BEFORE the tool's own <script> block:
     <script src="os-config.js"></script>

   HOW MODEL SELECTION WORKS (checked in this order):
     1. localStorage "os_model"   — set via the Settings panel on
        the phone. Overrides everything else, no redeploy needed.
     2. DEFAULT_MODEL below       — the built-in fallback. Update
        this (and re-upload this ONE file) if Brian never sets an
        override and a model retires.

   STATUS CHECK (os-status.json):
     On page load, each tool calls checkModelStatus() once. It
     fetches os-status.json from this same GitHub Pages site
     (same-origin — no CORS risk, unlike fetching Anthropic's docs
     directly from the browser) and, if the currently-configured
     model is listed as deprecated/retired, returns a warning
     object the tool can render as a banner. Any failure (offline,
     file missing, bad JSON) is swallowed — this NEVER blocks the
     tool from working, it's purely advisory.

     os-status.json is a ONE-TIME SNAPSHOT (dated inside the file)
     from whenever it was last generated — there is no automated
     refresh (deliberately skipped; not worth the maintenance for
     the marginal benefit given the two checks below). It will go
     stale over time and may eventually under-warn. Treat it as a
     bonus, not a guarantee. The two things that ARE always
     accurate:
       1. The "Check Model" button (pingModel()) — a live test call.
       2. friendlyModelError() — fires on any real not_found_error.

   ============================================================
   CHANGELOG
   v1.0  2026-07-11  Initial version
     - Extracted from invoice_check.html / receipt_scanner.html
       after claude-sonnet-4-20250514 was retired (2026-06-15) and
       broke both tools with not_found_error.
   ============================================================ */

const DEFAULT_MODEL = "claude-sonnet-4-6";

function getModel() {
  return (localStorage.getItem("os_model") || "").trim() || DEFAULT_MODEL;
}

function setModel(modelId) {
  const v = (modelId || "").trim();
  if (v) localStorage.setItem("os_model", v);
  else localStorage.removeItem("os_model"); // empty input = "use default"
}

function isUsingDefaultModel() {
  return !(localStorage.getItem("os_model") || "").trim();
}

/**
 * Fetches os-status.json (same-origin) and checks it against the
 * currently-configured model. Returns a Promise resolving to:
 *   null                                   — no issue, or check failed silently
 *   { level, message, recommended, retirementDate } — something to show the user
 * Never throws.
 */
async function checkModelStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // never hang the page
    const resp = await fetch("os-status.json", { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    const status = await resp.json();
    const current = getModel();
    const entry = status.models && status.models[current];
    if (!entry) return null; // model not flagged — nothing to warn about

    if (entry.state === "retired") {
      return {
        level: "error",
        message: `The model this tool is using ("${current}") has been retired by Anthropic. It will fail until you update it.`,
        recommended: entry.recommended_replacement || null,
        retirementDate: entry.retirement_date || null
      };
    }
    if (entry.state === "deprecated") {
      return {
        level: "warn",
        message: `The model this tool is using ("${current}") is deprecated and will retire on ${entry.retirement_date || "an upcoming date"}.`,
        recommended: entry.recommended_replacement || null,
        retirementDate: entry.retirement_date || null
      };
    }
    return null;
  } catch (e) {
    return null; // offline / blocked / malformed — fail silent, never block the tool
  }
}

/**
 * Renders a dismissible banner into the given container element
 * if checkModelStatus() found an issue. No-op otherwise.
 * Call after the page's own DOM is ready.
 */
async function renderModelStatusBanner(containerEl, onOpenSettings) {
  const status = await checkModelStatus();
  if (!status || !containerEl) return;

  const bg = status.level === "error" ? "#2d1416" : "#3a2e0d";
  const border = status.level === "error" ? "#f85149" : "#d29922";
  const color = status.level === "error" ? "#f85149" : "#d29922";

  const banner = document.createElement("div");
  banner.style.cssText = `background:${bg};border:1px solid ${border};color:${color};
    border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;line-height:1.5;`;

  let html = `<strong>${status.level === "error" ? "⚠ Model retired" : "⚠ Model retiring soon"}</strong><br>${status.message}`;
  if (status.recommended) html += `<br>Recommended: <code>${status.recommended}</code>`;
  html += `<br><button id="osStatusFixBtn" style="margin-top:8px;background:${color};color:#0f1419;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">Open Settings</button>`;
  banner.innerHTML = html;

  containerEl.prepend(banner);

  const btn = document.getElementById("osStatusFixBtn");
  if (btn && typeof onOpenSettings === "function") {
    btn.addEventListener("click", onOpenSettings);
  }
}

/**
 * Live, authoritative check: sends a 1-token test message to Anthropic
 * using the currently-configured model and the given API key. This is
 * more reliable than os-status.json (which depends on periodic
 * maintenance) because it asks Anthropic directly, right now, whether
 * the model actually works. Costs a negligible fraction of a cent.
 * Returns { ok: true, model } or { ok: false, model, message }.
 */
async function pingModel(apiKey) {
  const model = getModel();
  if (!apiKey) return { ok: false, model, message: "Enter your Anthropic API key first." };
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
    });
    const data = await resp.json();
    if (data.error) {
      const friendly = friendlyModelError(data.error);
      return { ok: false, model, message: friendly || (data.error.type + ": " + data.error.message) };
    }
    return { ok: true, model };
  } catch (e) {
    return { ok: false, model, message: "Couldn't reach Anthropic — check your internet connection and try again." };
  }
}

/**
 * Recognizes the specific "model not found / retired" API error shape
 * and returns a plain-language message instead of the raw JSON error.
 * Returns null if this isn't a model-not-found error (caller should
 * fall back to showing the raw error).
 */
function friendlyModelError(apiError) {
  if (!apiError || !apiError.type) return null;
  const msg = (apiError.message || "").toLowerCase();
  if (apiError.type === "not_found_error" && msg.includes("model")) {
    return `Claude's model ("${getModel()}") isn't available anymore — Anthropic likely retired it. `
         + `Open Settings, update the "Claude Model" field to a current model name, and try again. `
         + `(Ask Claude "what's the current recommended Sonnet model?" if you're not sure what to type.)`;
  }
  return null;
}
