// netlify/functions/api.js
// GET /.netlify/functions/api
// Returns the latest plugin data from GitHub

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO; // format: "user/repo"
const FILE_PATH = process.env.FILE_PATH || "data.json";

exports.handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  // Handle CORS preflight
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
    console.log(`[API] Fetching data from: ${apiUrl}`);

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

    console.log(`[API] Successfully fetched data.json — versions: ${parsed.plugin?.versions?.length ?? 0}`);

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
