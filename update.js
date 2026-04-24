// netlify/functions/update.js
// POST /.netlify/functions/update
// Receives new/updated plugin data and commits it to GitHub

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO; // format: "user/repo"
const FILE_PATH = process.env.FILE_PATH || "data.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // secret token for admin auth

const ALLOWED_TYPES = ["stable", "pre-release"];
const ALLOWED_STATUSES = ["success", "fail", "maintenance"];
const ALLOWED_LOADERS = ["PaperMC", "Bukkit", "Purpur"];

function validateVersion(v) {
  const errors = [];
  if (!v.name || typeof v.name !== "string" || v.name.trim().length === 0)
    errors.push("name is required");
  if (!v.version || typeof v.version !== "string" || v.version.trim().length === 0)
    errors.push("version is required");
  if (!ALLOWED_TYPES.includes(v.type))
    errors.push(`type must be one of: ${ALLOWED_TYPES.join(", ")}`);
  if (typeof v.latest !== "boolean")
    errors.push("latest must be a boolean");
  if (!ALLOWED_STATUSES.includes(v.status))
    errors.push(`status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
  if (!ALLOWED_LOADERS.includes(v.loader))
    errors.push(`loader must be one of: ${ALLOWED_LOADERS.join(", ")}`);
  if (!v.download || typeof v.download !== "string" || !v.download.startsWith("http"))
    errors.push("download must be a valid URL");
  return errors;
}

exports.handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  };

  // Handle CORS preflight
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

  // ─── Auth Check ───────────────────────────────────────────────
  const adminToken = event.headers["x-admin-token"] || event.headers["X-Admin-Token"];
  if (!ADMIN_TOKEN || adminToken !== ADMIN_TOKEN) {
    console.warn("[UPDATE] Unauthorized access attempt");
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Unauthorized: invalid or missing admin token" }),
    };
  }

  // ─── Parse Body ───────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const { plugin, newVersion, pluginName } = body;

  // Support two modes:
  // 1. Full plugin object replacement: { plugin: { name, versions } }
  // 2. Append single version: { newVersion: {...}, pluginName: "..." }

  if (!GITHUB_TOKEN || !REPO) {
    console.error("[UPDATE] Missing environment variables");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server misconfiguration" }),
    };
  }

  try {
    // ─── Fetch current data.json from GitHub ──────────────────
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
      console.log(`[UPDATE] Current SHA: ${currentSha}, versions: ${currentData.plugin?.versions?.length}`);
    } else if (getResponse.status === 404) {
      console.log("[UPDATE] data.json not found — will create new file");
    } else {
      const errText = await getResponse.text();
      console.error(`[UPDATE] GitHub fetch error ${getResponse.status}: ${errText}`);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Failed to fetch current data: ${getResponse.status}` }),
      };
    }

    // ─── Build New Data ───────────────────────────────────────
    let updatedData;

    if (plugin) {
      // Full replacement mode
      updatedData = { plugin };
    } else if (newVersion) {
      // Single version append/update mode
      const errors = validateVersion(newVersion);
      if (errors.length > 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Validation failed", details: errors }),
        };
      }

      let versions = currentData.plugin?.versions || [];

      // Check if version already exists — update it
      const existingIdx = versions.findIndex(v => v.version === newVersion.version);
      if (existingIdx >= 0) {
        console.log(`[UPDATE] Updating existing version: ${newVersion.version}`);
        versions[existingIdx] = newVersion;
      } else {
        console.log(`[UPDATE] Appending new version: ${newVersion.version}`);
        versions.push(newVersion);
      }

      // Enforce only one "latest"
      if (newVersion.latest) {
        versions = versions.map(v => ({
          ...v,
          latest: v.version === newVersion.version,
        }));
        console.log(`[UPDATE] Set latest=true only for version ${newVersion.version}`);
      }

      updatedData = {
        plugin: {
          name: pluginName || currentData.plugin?.name || "Plugin",
          versions,
        },
      };
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Body must contain either 'plugin' or 'newVersion'" }),
      };
    }

    // ─── Commit to GitHub ─────────────────────────────────────
    const newContent = Buffer.from(JSON.stringify(updatedData, null, 2)).toString("base64");

    const commitBody = {
      message: `chore: update plugin data — ${new Date().toISOString()}`,
      content: newContent,
      ...(currentSha && { sha: currentSha }),
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
    console.log(`[UPDATE] Successfully committed. New SHA: ${putData.content?.sha}`);

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
