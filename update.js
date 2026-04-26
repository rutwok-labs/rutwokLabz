

const crypto = require("crypto");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO;
const FILE_PATH = process.env.FILE_PATH || "data.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const ALLOWED_TYPES = ["stable", "pre-release"];
const ALLOWED_STATUSES = ["success", "fail", "maintenance"];
const ALLOWED_LOADERS = ["PaperMC", "Bukkit", "Purpur"];

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpsUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function readHeader(headers, name) {
  if (!headers) return "";
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function safeEqualToken(input) {
  if (!ADMIN_TOKEN || typeof input !== "string") return false;
  const left = Buffer.from(ADMIN_TOKEN);
  const right = Buffer.from(input);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function normalizeRelease(release) {
  return {
    name: str(release.name),
    version: str(release.version),
    type: str(release.type) || "stable",
    latest: release.latest === true,
    status: str(release.status) || "success",
    loader: str(release.loader) || "PaperMC",
    download: str(release.download),
  };
}

function normalizePlugin(plugin) {
  return {
    name: str(plugin.name),
    releases: Array.isArray(plugin.releases) ? plugin.releases.map(normalizeRelease) : [],
  };
}

function normalizeSection(section) {
  return {
    name: str(section.name),
    plugins: Array.isArray(section.plugins) ? section.plugins.map(normalizePlugin) : [],
  };
}

function normalizeCatalog(input) {
  const catalog = input?.catalog || {};
  return {
    catalog: {
      title: str(catalog.title) || "Plugin Catalog",
      core: {
        plugins: Array.isArray(catalog.core?.plugins) ? catalog.core.plugins.map(normalizePlugin) : [],
      },
      addons: {
        sections: Array.isArray(catalog.addons?.sections) ? catalog.addons.sections.map(normalizeSection) : [],
      },
    },
  };
}

function validateRelease(release, path) {
  const errors = [];
  if (!str(release.name)) errors.push(`${path}.name is required`);
  if (!str(release.version)) errors.push(`${path}.version is required`);
  if (!ALLOWED_TYPES.includes(release.type)) errors.push(`${path}.type must be one of: ${ALLOWED_TYPES.join(", ")}`);
  if (typeof release.latest !== "boolean") errors.push(`${path}.latest must be a boolean`);
  if (!ALLOWED_STATUSES.includes(release.status)) errors.push(`${path}.status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
  if (!ALLOWED_LOADERS.includes(release.loader)) errors.push(`${path}.loader must be one of: ${ALLOWED_LOADERS.join(", ")}`);
  if (!isHttpsUrl(release.download)) errors.push(`${path}.download must be a valid https URL`);
  return errors;
}

function validatePlugin(plugin, path) {
  const errors = [];
  if (!str(plugin.name)) errors.push(`${path}.name is required`);
  if (!Array.isArray(plugin.releases)) errors.push(`${path}.releases must be an array`);

  const releases = Array.isArray(plugin.releases) ? plugin.releases : [];
  const versions = new Set();
  let latestCount = 0;

  releases.forEach((release, index) => {
    errors.push(...validateRelease(release, `${path}.releases[${index}]`));
    const key = str(release.version).toLowerCase();
    if (key) {
      if (versions.has(key)) errors.push(`${path}.releases[${index}].version must be unique inside the plugin`);
      versions.add(key);
    }
    if (release.latest === true) latestCount += 1;
  });

  if (latestCount > 1) errors.push(`${path}.releases can only contain one latest release`);
  return errors;
}

function validateSection(section, path) {
  const errors = [];
  if (!str(section.name)) errors.push(`${path}.name is required`);
  if (!Array.isArray(section.plugins)) errors.push(`${path}.plugins must be an array`);

  const plugins = Array.isArray(section.plugins) ? section.plugins : [];
  const names = new Set();

  plugins.forEach((plugin, index) => {
    errors.push(...validatePlugin(plugin, `${path}.plugins[${index}]`));
    const key = str(plugin.name).toLowerCase();
    if (key) {
      if (names.has(key)) errors.push(`${path}.plugins[${index}].name must be unique inside the section`);
      names.add(key);
    }
  });

  return errors;
}

function validateCatalog(input) {
  const errors = [];
  const catalog = input?.catalog;

  if (!catalog || typeof catalog !== "object") {
    return ["catalog is required"];
  }

  if (!str(catalog.title)) errors.push("catalog.title is required");
  if (!catalog.core || typeof catalog.core !== "object") errors.push("catalog.core is required");
  if (!catalog.addons || typeof catalog.addons !== "object") errors.push("catalog.addons is required");
  if (!Array.isArray(catalog.core?.plugins)) errors.push("catalog.core.plugins must be an array");
  if (!Array.isArray(catalog.addons?.sections)) errors.push("catalog.addons.sections must be an array");

  const corePlugins = Array.isArray(catalog.core?.plugins) ? catalog.core.plugins : [];
  const coreNames = new Set();
  corePlugins.forEach((plugin, index) => {
    errors.push(...validatePlugin(plugin, `catalog.core.plugins[${index}]`));
    const key = str(plugin.name).toLowerCase();
    if (key) {
      if (coreNames.has(key)) errors.push(`catalog.core.plugins[${index}].name must be unique`);
      coreNames.add(key);
    }
  });

  const sections = Array.isArray(catalog.addons?.sections) ? catalog.addons.sections : [];
  const sectionNames = new Set();
  sections.forEach((section, index) => {
    errors.push(...validateSection(section, `catalog.addons.sections[${index}]`));
    const key = str(section.name).toLowerCase();
    if (key) {
      if (sectionNames.has(key)) errors.push(`catalog.addons.sections[${index}].name must be unique`);
      sectionNames.add(key);
    }
  });

  return errors;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const adminToken = readHeader(event.headers, "x-admin-token");
  if (!safeEqualToken(adminToken)) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Unauthorized: invalid or missing admin token" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  if (body?.action === "validate") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    };
  }

  if (!GITHUB_TOKEN || !REPO) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server misconfiguration" }),
    };
  }

  const normalized = normalizeCatalog(body);
  const validationErrors = validateCatalog(normalized);
  if (validationErrors.length > 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Validation failed", details: validationErrors }),
    };
  }

  try {
    const apiUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
    const getResponse = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Netlify-Plugin-Dashboard",
      },
    });

    let currentSha = null;
    if (getResponse.ok) {
      const currentFile = await getResponse.json();
      currentSha = currentFile.sha;
    } else if (getResponse.status !== 404) {
      const errText = await getResponse.text();
      console.error(`[UPDATE] GitHub fetch error ${getResponse.status}: ${errText}`);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Failed to fetch current data: ${getResponse.status}` }),
      };
    }

    const content = Buffer.from(JSON.stringify(normalized, null, 2)).toString("base64");
    const commitBody = {
      message: `chore: update plugin catalog - ${new Date().toISOString()}`,
      content,
      ...(currentSha ? { sha: currentSha } : {}),
    };

    const putResponse = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Netlify-Plugin-Dashboard",
      },
      body: JSON.stringify(commitBody),
    });

    if (!putResponse.ok) {
      const errText = await putResponse.text();
      console.error(`[UPDATE] GitHub commit error ${putResponse.status}: ${errText}`);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Failed to commit to GitHub: ${putResponse.status}` }),
      };
    }

    const putData = await putResponse.json();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: "Catalog updated successfully",
        sha: putData.content?.sha,
        data: normalized,
      }),
    };
  } catch (err) {
    console.error("[UPDATE] Unexpected error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error", details: err.message }),
    };
  }
};
