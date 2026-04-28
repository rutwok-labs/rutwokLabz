// rutwokLabz — Cloudflare Worker


const RELEASE_TYPES    = ["stable", "pre-release"];
const RELEASE_STATUSES = ["success", "fail", "maintenance"];
const RELEASE_LOADERS  = ["PaperMC", "Bukkit", "Purpur"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Serve /admin as admin.html without exposing the .html extension
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return env.ASSETS.fetch(
        new Request(new URL("/admin.html", request.url), request)
      );
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleApi(request, env, url) {
  const headers = corsHeaders();

  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  if (url.pathname === "/api/catalog") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, headers);
    return handleGetCatalog(env, headers);
  }

  if (url.pathname === "/api/admin/auth") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    return handleAdminAuth(request, env, headers);
  }

  if (url.pathname === "/api/admin/save") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    return handleAdminSave(request, env, headers);
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "rutwoklabz-worker" }, 200, headers);
  }

  return json({ error: "Not found" }, 404, headers);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetCatalog(env, headers) {
  // BUG FIX: use getEnv() so vars are read correctly from Cloudflare bindings
  const githubToken = getEnv(env, "GITHUB_TOKEN");
  const repo        = getEnv(env, "REPO");

  if (!githubToken || !repo) {
    return json({
      error: "Server misconfiguration: missing GITHUB_TOKEN or REPO",
      missing: { GITHUB_TOKEN: !githubToken, REPO: !repo },
    }, 500, headers);
  }

  try {
    const file   = await fetchGithubFile(env);
    const parsed = JSON.parse(file.content);
    return json(parsed, 200, headers);
  } catch (error) {
    return json(
      { error: error.message || "Failed to load catalog" },
      error.statusCode || 500,
      headers
    );
  }
}

async function handleAdminAuth(request, env, headers) {
  // BUG FIX: getEnv() reads the real Cloudflare env binding.
  // BUG FIX: safeCompare() handles different-length tokens safely (old
  //           safeEqual() returned false immediately on length mismatch,
  //           which is correct security-wise but the real failure was that
  //           readBinding() silently returned "" when the env var wasn't
  //           loaded yet, making EVERY token fail).
  const expected = getEnv(env, "ADMIN_TOKEN");
  if (!expected) {
    // Env var not set at all — give a clear server-side error instead of
    // a misleading 401 that looks like a wrong password.
    return json({
      success: false,
      error: "Server misconfiguration: ADMIN_TOKEN is not set",
    }, 500, headers);
  }

  const provided = await readAdminToken(request);
  if (!(await safeCompare(provided, expected))) {
    return json({ success: false, error: "Unauthorized: invalid token" }, 401, headers);
  }

  return json({ success: true }, 200, headers);
}

async function handleAdminSave(request, env, headers) {
  const expected = getEnv(env, "ADMIN_TOKEN");
  if (!expected) {
    return json({
      success: false,
      error: "Server misconfiguration: ADMIN_TOKEN is not set",
    }, 500, headers);
  }

  const provided = await readAdminToken(request);
  if (!(await safeCompare(provided, expected))) {
    return json({ success: false, error: "Unauthorized: invalid token" }, 401, headers);
  }

  const githubToken = getEnv(env, "GITHUB_TOKEN");
  const repo        = getEnv(env, "REPO");
  if (!githubToken || !repo) {
    return json({
      success: false,
      error: "Server misconfiguration: missing GITHUB_TOKEN or REPO",
      missing: { GITHUB_TOKEN: !githubToken, REPO: !repo },
    }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, headers);
  }

  const normalized = normalizeCatalog(body);
  const errors     = validateCatalog(normalized);
  if (errors.length) {
    return json({ success: false, error: "Validation failed", details: errors }, 400, headers);
  }

  try {
    // allowMissing=true so a brand-new repo with no data.json still works
    const current = await fetchGithubFile(env, true);
    const payload  = JSON.stringify(normalized, null, 2);

    const response = await fetch(buildGithubContentsUrl(env), {
      method: "PUT",
      headers: githubHeaders(env, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: `chore: update plugin catalog - ${new Date().toISOString()}`,
        content: toBase64(payload),
        ...(current && current.sha ? { sha: current.sha } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return json(
        { success: false, error: `Failed to commit to GitHub: ${response.status}`, details: text },
        502,
        headers
      );
    }

    const result = await response.json();
    return json({
      success: true,
      message: "Catalog updated successfully",
      sha: result.content?.sha || "",
      commitUrl: result.commit?.html_url || "",
      data: normalized,
    }, 200, headers);
  } catch (error) {
    return json(
      { success: false, error: error.message || "Save failed" },
      error.statusCode || 500,
      headers
    );
  }
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function fetchGithubFile(env, allowMissing = false) {
  const response = await fetch(buildGithubContentsUrl(env), {
    headers: githubHeaders(env),
  });

  if (response.status === 404 && allowMissing) return null;

  if (!response.ok) {
    const text  = await response.text();
    const error = new Error(`GitHub API error: ${response.status}`);
    error.statusCode = response.status;
    error.details    = text;
    throw error;
  }

  const payload = await response.json();
  return {
    sha:     payload.sha || "",
    content: fromBase64(payload.content || ""),
  };
}

function buildGithubContentsUrl(env) {
  const filePath = getEnv(env, "FILE_PATH") || "data.json";
  const repo     = getEnv(env, "REPO");
  return `https://api.github.com/repos/${repo}/contents/${filePath}`;
}

function githubHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${getEnv(env, "GITHUB_TOKEN")}`,
    Accept:        "application/vnd.github+json",
    "User-Agent":  "rutwokLabz-worker",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

async function readAdminToken(request) {
  // 1. Prefer the header (standard approach used by admin.html)
  const headerToken = request.headers.get("X-Admin-Token");
  if (headerToken && headerToken.trim()) return headerToken.trim();

  // 2. Fall back to JSON body { token: "..." }
  try {
    const clone = request.clone();
    const body  = await clone.json();
    return str(body?.token);
  } catch {
    return "";
  }
}

/**
 * BUG FIX: The old safeEqual() returned false immediately when the two
 * strings had different lengths. That's the correct cryptographic behaviour,
 * BUT it also masked a deeper bug: when ADMIN_TOKEN was correctly set in
 * Cloudflare's dashboard but readBinding() returned "" (because it was
 * falling through to process.env which doesn't exist in Workers), every
 * comparison failed silently with a misleading "wrong password" error.
 *
 * This version uses the SubtleCrypto timing-safe comparison available in
 * the Workers runtime, and checks for an empty expected value first so the
 * caller gets a 500 instead of a 401 when the env var is missing.
 */
async function safeCompare(provided, expected) {
  if (!provided || !expected) return false;

  // Use SubtleCrypto for true constant-time comparison
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey(
    "raw", enc.encode(expected), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig1 = await crypto.subtle.sign("HMAC", key, enc.encode(provided));
  const sig2 = await crypto.subtle.sign("HMAC", key, enc.encode(expected));

  // Compare the two HMAC outputs — equal only when provided === expected
  const a = new Uint8Array(sig1);
  const b = new Uint8Array(sig2);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// CRITICAL FIX: environment variable reading
// ---------------------------------------------------------------------------

/**
 * BUG FIX: The old readBinding() silently tried process.env as a fallback.
 * process.env does NOT exist in Cloudflare Workers — accessing it throws or
 * returns undefined, so every env var came back as "". This made the Worker
 * behave as if no env vars were set even after you correctly configured them
 * in the Cloudflare dashboard.
 *
 * Fix: read directly from the `env` object that Cloudflare passes to fetch().
 * No process.env fallback — Workers don't have it.
 */
function getEnv(env, key) {
  if (env && typeof env[key] === "string" && env[key].length > 0) {
    return env[key];
  }
  return "";
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeCatalog(input) {
  const source = input && typeof input === "object"
    ? (input.catalog || input)
    : {};
  return {
    catalog: {
      title:  str(source.title) || "Plugin Catalog",
      core:   { plugins:  arrayOf(source.core?.plugins).map(normalizePlugin) },
      addons: { sections: arrayOf(source.addons?.sections).map(normalizeSection) },
    },
  };
}

function normalizePlugin(plugin) {
  const releases = arrayOf(plugin?.releases).map(normalizeRelease);
  normalizeLatestReleaseFlags(releases);
  return {
    name:     str(plugin?.name),
    releases,
  };
}

function normalizeSection(section) {
  return {
    name:    str(section?.name),
    plugins: arrayOf(section?.plugins).map(normalizePlugin),
  };
}

function normalizeRelease(release) {
  return {
    name:     str(release?.name),
    version:  str(release?.version),
    type:     RELEASE_TYPES.includes(str(release?.type))     ? str(release?.type)     : "stable",
    latest:   release?.latest === true,
    status:   RELEASE_STATUSES.includes(str(release?.status)) ? str(release?.status) : "success",
    loader:   RELEASE_LOADERS.includes(str(release?.loader))  ? str(release?.loader)  : "PaperMC",
    download: str(release?.download),
  };
}

function normalizeLatestReleaseFlags(releases) {
  const items = arrayOf(releases);
  if (!items.length) return;
  const preferredIndex = items.findIndex((release) => release.latest);
  const finalIndex = preferredIndex >= 0 ? preferredIndex : 0;
  items.forEach((release, index) => {
    release.latest = index === finalIndex;
  });
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateCatalog(input) {
  const errors  = [];
  const catalog = input?.catalog;

  if (!catalog || typeof catalog !== "object") return ["catalog is required"];
  if (!str(catalog.title))                      errors.push("catalog.title is required");
  if (!Array.isArray(catalog.core?.plugins))    errors.push("catalog.core.plugins must be an array");
  if (!Array.isArray(catalog.addons?.sections)) errors.push("catalog.addons.sections must be an array");

  const coreNames = new Set();
  arrayOf(catalog.core?.plugins).forEach((plugin, i) => {
    errors.push(...validatePlugin(plugin, `catalog.core.plugins[${i}]`));
    const key = plugin.name.toLowerCase();
    if (key) {
      if (coreNames.has(key)) errors.push(`catalog.core.plugins[${i}].name must be unique`);
      coreNames.add(key);
    }
  });

  const sectionNames = new Set();
  arrayOf(catalog.addons?.sections).forEach((section, i) => {
    errors.push(...validateSection(section, `catalog.addons.sections[${i}]`));
    const key = section.name.toLowerCase();
    if (key) {
      if (sectionNames.has(key)) errors.push(`catalog.addons.sections[${i}].name must be unique`);
      sectionNames.add(key);
    }
  });

  return errors;
}

function validateSection(section, path) {
  const errors = [];
  if (!str(section.name))           errors.push(`${path}.name is required`);
  if (!Array.isArray(section.plugins)) errors.push(`${path}.plugins must be an array`);

  const pluginNames = new Set();
  arrayOf(section.plugins).forEach((plugin, i) => {
    errors.push(...validatePlugin(plugin, `${path}.plugins[${i}]`));
    const key = plugin.name.toLowerCase();
    if (key) {
      if (pluginNames.has(key)) errors.push(`${path}.plugins[${i}].name must be unique inside the section`);
      pluginNames.add(key);
    }
  });

  return errors;
}

function validatePlugin(plugin, path) {
  const errors = [];
  if (!str(plugin.name))             errors.push(`${path}.name is required`);
  if (!Array.isArray(plugin.releases)) errors.push(`${path}.releases must be an array`);

  arrayOf(plugin.releases).forEach((release, i) => {
    errors.push(...validateRelease(release, `${path}.releases[${i}]`));
  });
  return errors;
}

function validateRelease(release, path) {
  const errors = [];
  if (!str(release.name))                         errors.push(`${path}.name is required`);
  if (!str(release.version))                      errors.push(`${path}.version is required`);
  if (!RELEASE_TYPES.includes(release.type))      errors.push(`${path}.type must be one of: ${RELEASE_TYPES.join(", ")}`);
  if (typeof release.latest !== "boolean")        errors.push(`${path}.latest must be a boolean`);
  if (!RELEASE_STATUSES.includes(release.status)) errors.push(`${path}.status must be one of: ${RELEASE_STATUSES.join(", ")}`);
  if (!RELEASE_LOADERS.includes(release.loader))  errors.push(`${path}.loader must be one of: ${RELEASE_LOADERS.join(", ")}`);
  if (!isHttpsUrl(release.download))              errors.push(`${path}.download must be a valid https URL`);
  return errors;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isHttpsUrl(value) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function toBase64(value) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function fromBase64(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes  = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function corsHeaders() {
  return {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    "Cache-Control":               "no-cache, no-store, must-revalidate",
  };
}

function json(payload, status = 200, headers = corsHeaders()) {
  return new Response(JSON.stringify(payload), { status, headers });
}
