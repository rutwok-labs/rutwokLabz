# ⚡ Plugin Release Dashboard

A lightweight Modrinth-style plugin hosting dashboard.
**Stack:** Netlify (hosting + serverless functions) · GitHub (data storage) · Vanilla JS (no framework)

---

## 📁 File Structure

```
plugin-release-system/
├── index.html                   # Public release page
├── admin.html                   # Admin panel (password-protected)
├── data.json                    # Seed data — committed to GitHub repo
├── netlify.toml                 # Netlify build + headers config
├── package.json
├── .env.example                 # Copy → .env for local dev
└── netlify/
    └── functions/
        ├── api.js               # GET  /.netlify/functions/api
        └── update.js            # POST /.netlify/functions/update
```

---

## 🚀 Deployment (Step-by-Step)

### 1. Create a GitHub repository

1. Go to [github.com/new](https://github.com/new) and create a new **public or private** repo.
2. Upload/push all these files to the root of the repo, including `data.json`.

### 2. Generate a GitHub Personal Access Token

1. Go to **GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens** (or classic).
2. Grant **Contents: Read and Write** permission for your repo.
3. Copy the token — you'll need it in step 4.

### 3. Deploy to Netlify

**Option A — Netlify UI (recommended):**
1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import from Git**.
2. Connect your GitHub repo.
3. Build settings:
   - **Build command:** *(leave blank)*
   - **Publish directory:** `.`
4. Click **Deploy site**.

**Option B — Netlify CLI:**
```bash
npm install -g netlify-cli
netlify login
netlify init        # link to your repo
netlify deploy --prod
```

### 4. Set Environment Variables in Netlify

Go to **Site Settings → Environment Variables** and add:

| Variable | Value | Description |
|---|---|---|
| `GITHUB_TOKEN` | `ghp_xxxx...` | Your GitHub PAT from step 2 |
| `REPO` | `username/repo-name` | Your GitHub repo path |
| `FILE_PATH` | `data.json` | Path to data file in the repo |
| `ADMIN_TOKEN` | `any-secret-string` | Password for the admin panel |

After adding variables, **trigger a redeploy** from the Netlify dashboard.

---

## 🖥 Usage

### Public Dashboard — `index.html`
- Lists all plugin versions in card layout
- Latest version highlighted with gold border + badge
- Status badges: ✅ success / ❌ fail / 🔧 maintenance
- Download button links directly to GitHub release

### Admin Panel — `admin.html`
1. Open `yoursite.netlify.app/admin.html`
2. Enter your `ADMIN_TOKEN` at the login screen
3. Fill in the version form and click **Save & Push to GitHub**
4. Auto-save triggers 1.8s after your last keystroke
5. Click any version in the right panel to edit it
6. Click ✕ on a version to delete it

---

## 🔌 API Reference

### `GET /.netlify/functions/api`
Returns the full `data.json` content.

```json
{
  "plugin": {
    "name": "ExamplePlugin",
    "versions": [
      {
        "name": "Stable Release",
        "version": "2.1.0",
        "type": "stable",
        "latest": true,
        "status": "success",
        "loader": "PaperMC",
        "download": "https://github.com/.../releases/download/..."
      }
    ]
  }
}
```

### `POST /.netlify/functions/update`
Updates `data.json` on GitHub. Requires `X-Admin-Token` header.

**Headers:**
```
Content-Type: application/json
X-Admin-Token: your-admin-token
```

**Body (full replace):**
```json
{
  "plugin": {
    "name": "ExamplePlugin",
    "versions": [ ... ]
  }
}
```

**Body (single version append/update):**
```json
{
  "pluginName": "ExamplePlugin",
  "newVersion": {
    "name": "New Release",
    "version": "3.0.0",
    "type": "stable",
    "latest": true,
    "status": "success",
    "loader": "PaperMC",
    "download": "https://github.com/..."
  }
}
```

---

## 🔒 Security Notes

- The `GITHUB_TOKEN` and `ADMIN_TOKEN` are **never exposed to the browser** — they live only in Netlify's environment and are accessed by serverless functions.
- The admin panel uses a client-side token check against `ADMIN_TOKEN` via the `X-Admin-Token` header on every write request. The serverless function rejects requests with wrong/missing tokens with HTTP 401.
- Inputs are validated server-side before any GitHub write occurs.

---

## 🛠 Local Development

```bash
# Install Netlify CLI
npm install

# Create local env file
cp .env.example .env
# Fill in your real values in .env

# Start local dev server (functions + static files)
npx netlify dev
```

Open `http://localhost:8888` — functions run at `http://localhost:8888/.netlify/functions/`.

---

## 📐 data.json Schema

```json
{
  "plugin": {
    "name": "string",
    "versions": [
      {
        "name": "string",
        "version": "string",
        "type": "stable | pre-release",
        "latest": true,
        "status": "success | fail | maintenance",
        "loader": "PaperMC | Bukkit | Purpur",
        "download": "https://..."
      }
    ]
  }
}
```

**Rules enforced by the API:**
- Only **one** version may have `"latest": true` — setting a new one automatically removes it from others.
- `download` must be a URL starting with `https://`.
- `type`, `status`, and `loader` are validated against allowed values.

---

## 💡 Tips

- **Custom domain:** Set it in Netlify → Domain Management.
- **Multiple plugins:** Fork the repo and deploy a second Netlify site pointing to a different `REPO`.
- **Auto-update clients:** Point your Minecraft server's update-checker to `GET /.netlify/functions/api` — it returns JSON with the latest version info.
