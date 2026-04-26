const RELEASE_TYPES = ["stable", "pre-release"];
const RELEASE_STATUSES = ["success", "fail", "maintenance"];
const RELEASE_LOADERS = ["PaperMC", "Bukkit", "Purpur"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (url.pathname === "/admin") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const headers = corsHeaders();

  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  if (url.pathname === "/api/catalog") {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, headers);
    }
    return handleGetCatalog(env, headers);
  }

  if (url.pathname === "/api/admin/auth") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, headers);
    }
    return handleAdminAuth(request, env, headers);
  }

  if (url.pathname === "/api/admin/save") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, headers);
    }
    return handleAdminSave(request, env, headers);
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "rutwoklabz-worker" }, 200, headers);
  }

  return json({ error: "Not found" }, 404, headers);
}

async function handleGetCatalog(env, headers) {
  const githubToken = readBinding(env, "GITHUB_TOKEN");
  const repo = readBinding(env, "REPO");
  if (!githubToken || !repo) {
    return json({
      error: "Server misconfiguration: missing GITHUB_TOKEN or REPO",
      missing: {
        GITHUB_TOKEN: !githubToken,
        REPO: !repo,
      },
    }, 500, headers);
  }

  try {
    const file = await fetchGithubFile(env);
    const parsed = JSON.parse(file.content);
    return json(parsed, 200, headers);
  } catch (error) {
    return json({ error: error.message || "Failed to load catalog" }, error.statusCode || 500, headers);
  }
}

async function handleAdminAuth(request, env, headers) {
  const token = await readAdminToken(request);
  if (!safeEqual(token, readBinding(env, "ADMIN_TOKEN"))) {
    return json({ success: false, error: "Unauthorized" }, 401, headers);
  }

  return json({ success: true }, 200, headers);
}

async function handleAdminSave(request, env, headers) {
  const token = await readAdminToken(request);
  if (!safeEqual(token, readBinding(env, "ADMIN_TOKEN"))) {
    return json({ success: false, error: "Unauthorized" }, 401, headers);
  }

  const githubToken = readBinding(env, "GITHUB_TOKEN");
  const repo = readBinding(env, "REPO");
  if (!githubToken || !repo) {
    return json({
      success: false,
      error: "Server misconfiguration: missing GITHUB_TOKEN or REPO",
      missing: {
        GITHUB_TOKEN: !githubToken,
        REPO: !repo,
      },
    }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, headers);
  }

  const normalized = normalizeCatalog(body);
  const errors = validateCatalog(normalized);
  if (errors.length) {
    return json({ success: false, error: "Validation failed", details: errors }, 400, headers);
  }

  try {
    const current = await fetchGithubFile(env, true);
    const payload = JSON.stringify(normalized, null, 2);
    const response = await fetch(buildGithubContentsUrl(env), {
      method: "PUT",
      headers: githubHeaders(env, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        message: `chore: update plugin catalog - ${new Date().toISOString()}`,
        content: toBase64(payload),
        ...(current && current.sha ? { sha: current.sha } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return json({ success: false, error: `Failed to commit to GitHub: ${response.status}`, details: text }, 502, headers);
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
    return json({ success: false, error: error.message || "Save failed" }, error.statusCode || 500, headers);
  }
}

function normalizeCatalog(input) {
  const source = input && typeof input === "object" ? (input.catalog || input) : {};
  return {
    catalog: {
      title: str(source.title) || "Plugin Catalog",
      core: {
        plugins: arrayOf(source.core?.plugins).map(normalizePlugin),
      },
      addons: {
        sections: arrayOf(source.addons?.sections).map(normalizeSection),
      },
    },
  };
}

function normalizePlugin(plugin) {
  return {
    name: str(plugin?.name),
    releases: arrayOf(plugin?.releases).map(normalizeRelease),
  };
}

function normalizeSection(section) {
  return {
    name: str(section?.name),
    plugins: arrayOf(section?.plugins).map(normalizePlugin),
  };
}

function normalizeRelease(release) {
  return {
    name: str(release?.name),
    version: str(release?.version),
    type: RELEASE_TYPES.includes(str(release?.type)) ? str(release?.type) : "stable",
    latest: release?.latest === true,
    status: RELEASE_STATUSES.includes(str(release?.status)) ? str(release?.status) : "success",
    loader: RELEASE_LOADERS.includes(str(release?.loader)) ? str(release?.loader) : "PaperMC",
    download: str(release?.download),
  };
}

function validateCatalog(input) {
  const errors = [];
  const catalog = input?.catalog;

  if (!catalog || typeof catalog !== "object") {
    return ["catalog is required"];
  }

  if (!str(catalog.title)) errors.push("catalog.title is required");
  if (!Array.isArray(catalog.core?.plugins)) errors.push("catalog.core.plugins must be an array");
  if (!Array.isArray(catalog.addons?.sections)) errors.push("catalog.addons.sections must be an array");

  const coreNames = new Set();
  arrayOf(catalog.core?.plugins).forEach((plugin, pluginIndex) => {
    errors.push(...validatePlugin(plugin, `catalog.core.plugins[${pluginIndex}]`));
    const key = plugin.name.toLowerCase();
    if (key) {
      if (coreNames.has(key)) errors.push(`catalog.core.plugins[${pluginIndex}].name must be unique`);
      coreNames.add(key);
    }
  });

  const sectionNames = new Set();
  arrayOf(catalog.addons?.sections).forEach((section, sectionIndex) => {
    errors.push(...validateSection(section, `catalog.addons.sections[${sectionIndex}]`));
    const key = section.name.toLowerCase();
    if (key) {
      if (sectionNames.has(key)) errors.push(`catalog.addons.sections[${sectionIndex}].name must be unique`);
      sectionNames.add(key);
    }
  });

  return errors;
}

function validateSection(section, path) {
  const errors = [];
  if (!str(section.name)) errors.push(`${path}.name is required`);
  if (!Array.isArray(section.plugins)) errors.push(`${path}.plugins must be an array`);

  const pluginNames = new Set();
  arrayOf(section.plugins).forEach((plugin, pluginIndex) => {
    errors.push(...validatePlugin(plugin, `${path}.plugins[${pluginIndex}]`));
    const key = plugin.name.toLowerCase();
    if (key) {
      if (pluginNames.has(key)) errors.push(`${path}.plugins[${pluginIndex}].name must be unique inside the section`);
      pluginNames.add(key);
    }
  });

  return errors;
}

function validatePlugin(plugin, path) {
  const errors = [];
  if (!str(plugin.name)) errors.push(`${path}.name is required`);
  if (!Array.isArray(plugin.releases)) errors.push(`${path}.releases must be an array`);

  const versions = new Set();
  let latestCount = 0;

  arrayOf(plugin.releases).forEach((release, releaseIndex) => {
    errors.push(...validateRelease(release, `${path}.releases[${releaseIndex}]`));
    const key = release.version.toLowerCase();
    if (key) {
      if (versions.has(key)) errors.push(`${path}.releases[${releaseIndex}].version must be unique inside the plugin`);
      versions.add(key);
    }
    if (release.latest) latestCount += 1;
  });

  if (latestCount > 1) errors.push(`${path}.releases can only contain one latest release`);
  return errors;
}

function validateRelease(release, path) {
  const errors = [];
  if (!str(release.name)) errors.push(`${path}.name is required`);
  if (!str(release.version)) errors.push(`${path}.version is required`);
  if (!RELEASE_TYPES.includes(release.type)) errors.push(`${path}.type must be one of: ${RELEASE_TYPES.join(", ")}`);
  if (typeof release.latest !== "boolean") errors.push(`${path}.latest must be a boolean`);
  if (!RELEASE_STATUSES.includes(release.status)) errors.push(`${path}.status must be one of: ${RELEASE_STATUSES.join(", ")}`);
  if (!RELEASE_LOADERS.includes(release.loader)) errors.push(`${path}.loader must be one of: ${RELEASE_LOADERS.join(", ")}`);
  if (!isHttpsUrl(release.download)) errors.push(`${path}.download must be a valid https URL`);
  return errors;
}

async function fetchGithubFile(env, allowMissing = false) {
  const response = await fetch(buildGithubContentsUrl(env), {
    headers: githubHeaders(env),
  });

  if (response.status === 404 && allowMissing) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`GitHub API error: ${response.status}`);
    error.statusCode = response.status;
    error.details = text;
    throw error;
  }

  const payload = await response.json();
  return {
    sha: payload.sha || "",
    content: fromBase64(payload.content || ""),
  };
}

function buildGithubContentsUrl(env) {
  const filePath = readBinding(env, "FILE_PATH") || "data.json";
  const repo = readBinding(env, "REPO");
  return `https://api.github.com/repos/${repo}/contents/${filePath}`;
}

function githubHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${readBinding(env, "GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "rutwokLabz-worker",
    ...extra,
  };
}

async function readAdminToken(request) {
  const headerToken = request.headers.get("X-Admin-Token");
  if (headerToken) return headerToken;

  try {
    const clone = request.clone();
    const body = await clone.json();
    return str(body?.token);
  } catch {
    return "";
  }
}

function safeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function isHttpsUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
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

function readBinding(env, key) {
  const direct = env && typeof env[key] === "string" ? env[key] : "";
  if (direct) return direct;

  if (typeof process !== "undefined" && process && process.env && typeof process.env[key] === "string") {
    return process.env[key];
  }

  return "";
}

function toBase64(value) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function fromBase64(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };
}

function json(payload, status = 200, headers = corsHeaders()) {
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}
