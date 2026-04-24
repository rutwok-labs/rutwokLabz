// netlify/functions/update.js
// POST /.netlify/functions/update
// Receives new/updated plugin data and commits it to GitHub

const crypto = require("crypto");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO; // format: "user/repo"
const FILE_PATH = process.env.FILE_PATH || "data.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // secret token for admin auth

const ALLOWED_TYPES = ["stable", "pre-release"];
const ALLOWED_STATUSES = ["success", "fail", "maintenance"];
const ALLOWED_LOADERS = ["PaperMC", "Bukkit", "Purpur"];

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function readHeader(headers, name) {
  if (!headers) return "";
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchedKey ? headers[matchedKey] : "";
}

function isAuthorizedToken(candidate) {
  if (!ADMIN_TOKEN || typeof candidate !== "string") return false;
  const expected = Buffer.from(ADMIN_TOKEN);
  const received = Buffer.from(candidate);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

function validateVersion(version, path = "plugin.versions[]") {
  const errors = [];
  const name = asTrimmedString(version?.name);
  const versionNumber = asTrimmedString(version?.version);
  const download = asTrimmedString(version?.download);
  const category = asTrimmedString(version?.category);
  const minecraft = asTrimmedString(version?.minecraft);
  const description = asTrimmedString(version?.description);

  if (!name) errors.push(`${path}.name is required`);
  if (!versionNumber) errors.push(`${path}.version is required`);
  if (!ALLOWED_TYPES.includes(version?.type)) {
    errors.push(`${path}.type must be one of: ${ALLOWED_TYPES.join(", ")}`);
  }
  if (typeof version?.latest !== "boolean") {
    errors.push(`${path}.latest must be a boolean`);
  }
  if (!ALLOWED_STATUSES.includes(version?.status)) {
    errors.push(`${path}.status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
  }
  if (!ALLOWED_LOADERS.includes(version?.loader)) {
    errors.push(`${path}.loader must be one of: ${ALLOWED_LOADERS.join(", ")}`);
  }
  if (!download || !isHttpsUrl(download)) {
    errors.push(`${path}.download must be a valid https URL`);
  }
  if (version?.category != null && !category) {
    errors.push(`${path}.category must be a non-empty string when provided`);
  }
  if (version?.minecraft != null && !minecraft) {
    errors.push(`${path}.minecraft must be a non-empty string when provided`);
  }
  if (version?.description != null && !description) {
    errors.push(`${path}.description must be a non-empty string when provided`);
  }
  if (version?.changelog != null && !Array.isArray(version.changelog)) {
    errors.push(`${path}.changelog must be an array of strings`);
  }
  if (Array.isArray(version?.changelog)) {
    version.changelog.forEach((entry, index) => {
      if (!asTrimmedString(entry)) {
        errors.push(`${path}.changelog[${index}] must be a non-empty string`);
      }
    });
  }

  return errors;
}

function validatePlugin(plugin) {
  const errors = [];
  const name = asTrimmedString(plugin?.name);
  const description = asTrimmedString(plugin?.description);
  const author = asTrimmedString(plugin?.author);
  const website = asTrimmedString(plugin?.website);
  const source = asTrimmedString(plugin?.source);
  const categories = Array.isArray(plugin?.categories) ? plugin.categories : [];
  const versions = Array.isArray(plugin?.versions) ? plugin.versions : [];

  if (!name) errors.push("plugin.name is required");
  if (plugin?.description != null && !description) {
    errors.push("plugin.description must be a non-empty string when provided");
  }
  if (plugin?.author != null && !author) {
    errors.push("plugin.author must be a non-empty string when provided");
  }
  if (plugin?.website != null && !website) {
    errors.push("plugin.website must be a non-empty string when provided");
  }
  if (website && !isHttpsUrl(website)) {
    errors.push("plugin.website must be a valid https URL");
  }
  if (plugin?.source != null && !source) {
    errors.push("plugin.source must be a non-empty string when provided");
  }
  if (source && !isHttpsUrl(source)) {
    errors.push("plugin.source must be a valid https URL");
  }
  if (plugin?.categories != null && !Array.isArray(plugin.categories)) {
    errors.push("plugin.categories must be an array of strings");
  }
  categories.forEach((category, index) => {
    if (!asTrimmedString(category)) {
      errors.push(`plugin.categories[${index}] must be a non-empty string`);
    }
  });
  if (!Array.isArray(plugin?.versions)) {
    errors.push("plugin.versions must be an array");
  }
  versions.forEach((version, index) => {
    errors.push(...validateVersion(version, `plugin.versions[${index}]`));
  });

  const versionKeys = new Set();
  versions.forEach((version, index) => {
    const key = asTrimmedString(version?.version).toLowerCase();
    if (!key) return;
    if (versionKeys.has(key)) {
      errors.push(`plugin.versions[${index}].version must be unique`);
    }
    versionKeys.add(key);
  });

  const latestCount = versions.filter((version) => version?.latest === true).length;
  if (latestCount > 1) {
    errors.push("plugin.versions can only contain one latest release");
  }

  return errors;
}

function normalizeVersion(version) {
  const normalized = {
    name: asTrimmedString(version.name),
    version: asTrimmedString(version.version),
    type: version.type,
    latest: version.latest === true,
    status: version.status,
    loader: version.loader,
    download: asTrimmedString(version.download),
  };

  const category = asTrimmedString(version.category);
  const minecraft = asTrimmedString(version.minecraft);
  const description = asTrimmedString(version.description);
  const changelog = Array.isArray(version.changelog)
    ? version.changelog.map((entry) => asTrimmedString(entry)).filter(Boolean)
    : [];

  if (category) normalized.category = category;
  if (minecraft) normalized.minecraft = minecraft;
  if (description) normalized.description = description;
  if (changelog.length) normalized.changelog = changelog;

  return normalized;
}

function normalizePlugin(plugin) {
  const normalized = {
    name: asTrimmedString(plugin.name),
    versions: Array.isArray(plugin.versions) ? plugin.versions.map(normalizeVersion) : [],
  };

  const description = asTrimmedString(plugin.description);
  const author = asTrimmedString(plugin.author);
  const website = asTrimmedString(plugin.website);
  const source = asTrimmedString(plugin.source);
  const categories = Array.isArray(plugin.categories)
    ? [...new Set(plugin.categories.map((category) => asTrimmedString(category)).filter(Boolean))]
    : [];

  if (description) normalized.description = description;
  if (author) normalized.author = author;
  if (website) normalized.website = website;
  if (source) normalized.source = source;
  if (categories.length) normalized.categories = categories;

  return normalized;
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
  if (!isAuthorizedToken(adminToken)) {
    console.warn("[UPDATE] Unauthorized access attempt");
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

  const { plugin, newVersion, pluginName } = body;

  if (!GITHUB_TOKEN || !REPO) {
    console.error("[UPDATE] Missing environment variables");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server misconfiguration" }),
    };
  }

  try {
    const apiUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
    console.log(`[UPDATE] Fetching current data from GitHub: ${apiUrl}`);

    const getResponse = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Netlify-Plugin-Dashboard",
      },
    });

    let currentSha = null;
    let currentData = { plugin: { name: pluginName || "Plugin", versions: [] } };

    if (getResponse.ok) {
      const fileData = await getResponse.json();
      currentSha = fileData.sha;
      const rawContent = Buffer.from(fileData.content, "base64").toString("utf-8");
      currentData = JSON.parse(rawContent);
      console.log(
        `[UPDATE] Current SHA: ${currentSha}, versions: ${currentData.plugin?.versions?.length || 0}`
      );
    } else if (getResponse.status === 404) {
      console.log("[UPDATE] data.json not found, creating a new file");
    } else {
      const errText = await getResponse.text();
      console.error(`[UPDATE] GitHub fetch error ${getResponse.status}: ${errText}`);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Failed to fetch current data: ${getResponse.status}` }),
      };
    }

    let updatedData;

    if (plugin) {
      const errors = validatePlugin(plugin);
      if (errors.length > 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Validation failed", details: errors }),
        };
      }
      updatedData = { plugin: normalizePlugin(plugin) };
    } else if (newVersion) {
      const errors = validateVersion(newVersion, "newVersion");
      if (errors.length > 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Validation failed", details: errors }),
        };
      }

      const normalizedVersion = normalizeVersion(newVersion);
      let versions = Array.isArray(currentData.plugin?.versions)
        ? currentData.plugin.versions.map(normalizeVersion)
        : [];

      const existingIndex = versions.findIndex((version) => version.version === normalizedVersion.version);
      if (existingIndex >= 0) {
        versions[existingIndex] = normalizedVersion;
      } else {
        versions.push(normalizedVersion);
      }

      if (normalizedVersion.latest) {
        versions = versions.map((version) => ({
          ...version,
          latest: version.version === normalizedVersion.version,
        }));
      }

      updatedData = {
        plugin: {
          ...normalizePlugin(currentData.plugin || {}),
          name: asTrimmedString(pluginName) || asTrimmedString(currentData.plugin?.name) || "Plugin",
          versions,
        },
      };

      const pluginErrors = validatePlugin(updatedData.plugin);
      if (pluginErrors.length > 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Validation failed", details: pluginErrors }),
        };
      }
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Body must contain either 'plugin', 'newVersion', or action='validate'" }),
      };
    }

    const newContent = Buffer.from(JSON.stringify(updatedData, null, 2)).toString("base64");

    const commitBody = {
      message: `chore: update plugin data - ${new Date().toISOString()}`,
      content: newContent,
      ...(currentSha ? { sha: currentSha } : {}),
    };

    console.log("[UPDATE] Committing updated data.json to GitHub...");
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
        message: "data.json updated successfully",
        sha: putData.content?.sha,
        data: updatedData,
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
