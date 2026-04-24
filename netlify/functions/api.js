// netlify/functions/api.js
// GET /.netlify/functions/api
// Returns plugin catalog data from GitHub

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO; // format: "user/repo"
const FILE_PATH = process.env.FILE_PATH || "data.json";

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    if (!GITHUB_TOKEN || !REPO) {
      console.error("[API] Missing environment variables: GITHUB_TOKEN or REPO");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Server misconfiguration: missing GitHub credentials" }),
      };
    }

    const apiUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Netlify-Plugin-Dashboard",
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[API] GitHub API error ${response.status}: ${errText}`);
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `GitHub API error: ${response.status}` }),
      };
    }

    const fileData = await response.json();
    const content = Buffer.from(fileData.content, "base64").toString("utf-8");
    const parsed = JSON.parse(content);

    const categoryCount = Array.isArray(parsed.catalog?.categories) ? parsed.catalog.categories.length : 0;
    const pluginCount = Array.isArray(parsed.catalog?.categories)
      ? parsed.catalog.categories.reduce((sum, category) => sum + (Array.isArray(category.plugins) ? category.plugins.length : 0), 0)
      : 0;

    console.log(`[API] Loaded catalog with ${categoryCount} categories and ${pluginCount} plugins`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    console.error("[API] Unexpected error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error", details: err.message }),
    };
  }
};
