// netlify/functions/update.js
// POST /.netlify/functions/update
// Validates and saves the plugin catalog to GitHub

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
  const a = Buffer.from(ADMIN_TOKEN);
  const b = Buffer.from(input);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeRelease(release) {
  return {
    name: str(release.name),
    version: str(release.version),
    type: str(release.type) || "stable",
    latest: release.latest === true,
    status: str(release.status) || "success",
    loader: str(release.loader) || "PaperMC",
    minecraft: str(release.minecraft),
    description: str(release.description),
    changelog: Array.isArray(release.changelog) ? release.changelog.map(str).filter(Boolean) : [],
    download: str(release.download),
  };
}

function normalizePlugin(plugin) {
  return {
    name: str(plugin.name),
    description: str(plugin.description),
    author: str(plugin.author),
    website: str(plugin.website),
    source: str(plugin.source),
    releases: Array.isArray(plugin.releases) ? plugin.releases.map(normalizeRelease) : [],
  };
}

function normalizeSubcategory(subcategory) {
  return {
    name: str(subcategory.name),
    plugins: Array.isArray(subcategory.plugins) ? subcategory.plugins.map(normalizePlugin) : [],
  };
}

function normalizeCategory(category) {
  return {
    name: str(category.name),
    subcategories: Array.isArray(category.subcategories) ? category.subcategories.map(normalizeSubcategory) : [],
  };
}

function normalizeCatalog(input) {
  const catalog = input?.catalog || {};
  return {
    catalog: {
      title: str(catalog.title) || "Plugin Catalog",
      description: str(catalog.description),
      categories: Array.isArray(catalog.categories) ? catalog.categories.map(normalizeCategory) : [],
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
  if (release.minecraft != null && !str(release.minecraft)) errors.push(`${path}.minecraft must be a non-empty string when provided`);
  if (release.description != null && !str(release.description)) errors.push(`${path}.description must be a non-empty string when provided`);
  if (release.changelog != null && !Array.isArray(release.changelog)) errors.push(`${path}.changelog must be an array of strings`);
  if (Array.isArray(release.changelog)) {
    release.changelog.forEach((item, index) => {
      if (!str(item)) errors.push(`${path}.changelog[${index}] must be a non-empty string`);
    });
  }
  return errors;
}

function validatePlugin(plugin, path) {
  const errors = [];
  if (!str(plugin.name)) errors.push(`${path}.name is required`);
  if (plugin.description != null && !str(plugin.description)) errors.push(`${path}.description must be a non-empty string when provided`);
  if (plugin.author != null && !str(plugin.author)) errors.push(`${path}.author must be a non-empty string when provided`);
  if (plugin.website && !isHttpsUrl(plugin.website)) errors.push(`${path}.website must be a valid https URL`);
  if (plugin.source && !isHttpsUrl(plugin.source)) errors.push(`${path}.source must be a valid https URL`);
  if (!Array.isArray(plugin.releases)) errors.push(`${path}.releases must be an array`);

  const releases = Array.isArray(plugin.releases) ? plugin.releases : [];
  const releaseVersions = new Set();
  let latestCount = 0;
  releases.forEach((release, index) => {
    errors.push(...validateRelease(release, `${path}.releases[${index}]`));
    const versionKey = str(release.version).toLowerCase();
    if (versionKey) {
      if (releaseVersions.has(versionKey)) errors.push(`${path}.releases[${index}].version must be unique inside the plugin`);
      releaseVersions.add(versionKey);
    }
    if (release.latest === true) latestCount += 1;
  });
  if (latestCount > 1) errors.push(`${path}.releases can only contain one latest release`);
  return errors;
}

function validateSubcategory(subcategory, path) {
  const errors = [];
  if (!str(subcategory.name)) errors.push(`${path}.name is required`);
  if (!Array.isArray(subcategory.plugins)) errors.push(`${path}.plugins must be an array`);

  const plugins = Array.isArray(subcategory.plugins) ? subcategory.plugins : [];
  const pluginNames = new Set();
  plugins.forEach((plugin, index) => {
    errors.push(...validatePlugin(plugin, `${path}.plugins[${index}]`));
    const key = str(plugin.name).toLowerCase();
    if (key) {
      if (pluginNames.has(key)) errors.push(`${path}.plugins[${index}].name must be unique inside the subcategory`);
      pluginNames.add(key);
    }
  });
  return errors;
}

function validateCategory(category, path) {
  const errors = [];
  if (!str(category.name)) errors.push(`${path}.name is required`);
  if (!Array.isArray(category.subcategories)) errors.push(`${path}.subcategories must be an array`);

  const subcategories = Array.isArray(category.subcategories) ? category.subcategories : [];
  const subcategoryNames = new Set();
  subcategories.forEach((subcategory, index) => {
    errors.push(...validateSubcategory(subcategory, `${path}.subcategories[${index}]`));
    const key = str(subcategory.name).toLowerCase();
    if (key) {
      if (subcategoryNames.has(key)) errors.push(`${path}.subcategories[${index}].name must be unique inside the category`);
      subcategoryNames.add(key);
    }
  });
  return errors;
}

function validateCatalog(input) {
  const errors = [];
  const catalog = input?.catalog;
  if (!catalog || typeof catalog !== "object") return ["catalog is required"];
  if (!str(catalog.title)) errors.push("catalog.title is required");
  if (catalog.description != null && !str(catalog.description)) errors.push("catalog.description must be a non-empty string when provided");
  if (!Array.isArray(catalog.categories)) errors.push("catalog.categories must be an array");

  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const categoryNames = new Set();
  categories.forEach((category, index) => {
    errors.push(...validateCategory(category, `catalog.categories[${index}]`));
    const key = str(category.name).toLowerCase();
    if (key) {
      if (categoryNames.has(key)) errors.push(`catalog.categories[${index}].name must be unique`);
      categoryNames.add(key);
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
