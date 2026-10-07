# PIN-DROP

A tiny 80s-terminal web page for moving a file between two devices that share **nothing but a web browser**.

1. On device A, open the site and press **[1] SEND**. Pick a file (up to 10 MB) and press **TRANSMIT**.
2. The screen shows a **4-digit PIN**.
3. On device B, open the same site, press **[2] RECEIVE** and type the PIN. The file downloads.

Files erase themselves after 5 min, 15 min or 1 hour (you choose). By default they also erase straight after the first download. Nothing to install on either device. No accounts, cookies or tracking.

It runs on **Cloudflare Workers, free plan**. You don't need a credit card, a server or a database.

---

## Deploy it (about 10 minutes, browser only)

You need a free **GitHub** account and a free **Cloudflare** account.

### 1. Put the code on GitHub
1. Unzip `pin-drop.zip`.
2. On github.com, click **New repository**. Name it `pin-drop` and make it **Private**.
3. On the empty repo page, click **uploading an existing file**. Drag in everything from the unzipped folder: `public/`, `src/`, `test/`, `package.json`, `wrangler.jsonc`, `README.md` and `.gitignore`.
4. Click **Commit changes**.

### 2. Connect it to Cloudflare
1. Log in at dash.cloudflare.com and go to **Workers & Pages**.
2. Click **Create**, then **Import a repository**. Authorise GitHub and pick `pin-drop`.
3. Keep the project name **`pin-drop`**. It must match `name` in `wrangler.jsonc`.
4. Leave the build settings at their defaults (deploy command `npx wrangler deploy`) and click **Deploy**.
5. When it finishes, the site is live at `https://pin-drop.<your-subdomain>.workers.dev`.

Every later commit to GitHub, including edits made on github.com itself, redeploys the site automatically.

### Alternative: deploy from a terminal
```bash
npm install
npx wrangler login
npx wrangler deploy
```

### Optional: use your own domain
In the Worker, go to **Settings → Domains & Routes → Add → Custom domain**, for example `drop.yourdomain.com`.

---

## Settings

Edit the `vars` block in `wrangler.jsonc` and commit. The site redeploys.

| Setting | Default | What it does |
|---|---|---|
| `MAX_FILE_MB` | `10` | Largest file accepted |
| `TTL_OPTIONS_MIN` | `5,15,60` | Expiry choices on the SEND screen, in minutes |
| `DEFAULT_TTL_MIN` | `15` | Choice selected by default |
| `ONCE_DEFAULT` | `true` | "Also erase after the first download" ticked by default |
| `ALLOWED_EXT` | office, PDF, image and zip types | Comma-separated list, or `*` for any type |
| `FAILS_PER_IP` | `5` | Wrong PINs allowed per network per 10 min |
| `FAILS_GLOBAL` | `20` | Wrong PINs allowed from everyone combined per 10 min. After that, lookups pause. |
| `UPLOADS_PER_IP` | `10` | Uploads allowed per network per 10 min |
| `MAX_ACTIVE_FILES` | `20` | Files that can wait for collection at once |
| `MAX_TOTAL_MB` | `200` | Total space waiting files can use |

---

## How safe is a 4-digit PIN?

A 4-digit PIN has only 10,000 possibilities. These rules make guessing it impractical:

- **5 wrong PINs from one network** locks that network for 10 minutes.
- **20 wrong PINs from everyone combined** pauses all lookups for up to 10 minutes. This holds even against someone guessing from many different networks.
- A file lives for at most 1 hour, so an attacker gets about **120 guesses at most**. That's roughly a **1% chance** at the 1-hour setting and under **0.5%** at the 15-minute default.
- With "erase after first download" on, the file is usually gone within a minute of being sent.
- A used PIN isn't reused for 24 hours, so an old PIN never opens someone else's newer file.
- **ERASE NOW** on the sender's screen deletes the file immediately.

The trade-off: if someone deliberately floods wrong PINs, lookups pause for everyone, including you, for up to 10 minutes. Your file stays safe.

Other details:
- Downloads are always forced to save as a file and never open in the browser, so an uploaded HTML file can't run as a page.
- The page loads nothing from other websites (the font is bundled), and a strict content security policy is set in `public/_headers`.
- Files are stored in **your own Cloudflare account**, in one Durable Object. Cloudflare encrypts them at rest. They are **not end-to-end encrypted**: whoever controls the Cloudflare account could read waiting files.

---

## Free-plan limits

This project uses a SQLite-backed Durable Object, which the free Workers plan includes (5 GB storage per account; each file is stored in 1 MB pieces). Personal use stays far inside the free allowances. If you ever exceed them, Cloudflare returns errors; it doesn't charge you.

---

## Before using this with work files

This is a direct path around your company's file-transfer controls. Corporate web filters often block new `*.workers.dev` sites outright, and moving work data outside approved tools is usually a policy matter. **Check with your InfoSec team first.**

---

## Project layout

```
public/            the web page (served as static files)
  index.html       screens: boot, menu, send, receive
  style.css        green/amber phosphor look, scanlines
  app.js           upload/download logic, no libraries
  fonts/           VT323 (SIL Open Font License)
  _headers         security headers
src/
  worker.js        API: /api/config, /upload, /peek, /download, /burn
  vault.js         Durable Object: storage, PINs, expiry, attempt limits
  config.js        reads settings from wrangler.jsonc
test/smoke.mjs     end-to-end API check
wrangler.jsonc     Cloudflare config + settings
```

## Run locally

```bash
npm install
npm run dev          # http://127.0.0.1:8787
npm test             # in a second terminal
BASE_URL=https://pin-drop.<you>.workers.dev npm test   # check the live site
```
