# free-web-screenshots

A production-minded Node.js service that captures screenshots of one or more websites on a schedule and uploads them to Google Drive.

## Features

- Playwright + Chromium screenshot capture
- In-app cron scheduler (default hourly)
- URL-safe UTC timestamped filenames
- Structured JSON logging (pino)
- Retry logic for temporary failures
- Health endpoint (`/health`) for containers
- Graceful shutdown (`SIGTERM` / `SIGINT`)
- Docker and docker-compose support
- First-run web setup + dashboard on `/`
- Optional login gate for setup/dashboard (`APP_USER` + `APP_PASS`)

## Security Model

### Default (recommended): `appdata`

Default Drive mode is:

- `GOOGLE_DRIVE_MODE=appdata`
- Scope: `https://www.googleapis.com/auth/drive.appdata`

This writes to Google Drive hidden `appDataFolder`:

- Not visible in normal Drive UI
- Accessible only by the authorized app

### Optional: `visible-folder`

If explicitly needed:

- `GOOGLE_DRIVE_MODE=visible-folder`
- `GOOGLE_DRIVE_FOLDER_ID=<folder-id>`
- Scope: `https://www.googleapis.com/auth/drive.file`

Tradeoff:

- Less restrictive than `appdata`
- Visible in normal Drive space

The app does not use full-drive scope.

## First-Run Web Setup Flow

After first deployment, open your app root (`/`).

1. If `APP_USER`/`APP_PASS` are configured, login page is required first.
2. Root shows setup form for runtime screenshot settings:
   - `TARGET_URLS`
   - `CRON_SCHEDULE`
   - `SCREENSHOT_DIR`
- `PRE_SCREENSHOT_SCRIPT` (optional JavaScript executed in the page before capture)
   - `SCREENSHOT_FULL_PAGE`
   - `VIEWPORT_WIDTH`
   - `VIEWPORT_HEIGHT`
   - `PAGE_TIMEOUT_MS`
   - `EXTRA_WAIT_MS`
   - `DELETE_LOCAL_AFTER_UPLOAD`
   - `RETRY_ATTEMPTS`
   - `RETRY_BASE_DELAY_MS`
   - `RETRY_MAX_DELAY_MS`
   - `GOOGLE_DRIVE_MODE`
   - `GOOGLE_DRIVE_FOLDER_ID`
3. Click **Proceed and Initialize**.
4. App persists runtime settings to:
   - `APP_RUNTIME_CONFIG_FILE` (JSON)
   - `APP_RUNTIME_ENV_FILE` (dotenv-style)
5. App redirects to Google OAuth start path (`OAUTH_SETUP_PATH`, default `/oauth/start`).
6. Google redirects back to callback path (`OAUTH_CALLBACK_PATH`, default `/callback`).
7. Refresh token is stored at `GOOGLE_TOKEN_FILE` and scheduler starts.
8. Root (`/`) becomes dashboard with metrics and scheduler restart/config update actions.

## Dashboard

Root dashboard includes:

- Total runs
- Total URL success count
- Total URL failure count
- Scheduler active state
- Reconfigure + save + restart
- Manual scheduler restart button

## Runtime Config Precedence

At startup, runtime settings are loaded in this order:

1. `APP_RUNTIME_CONFIG_FILE` (if present)
2. Bootstrap from environment variables (`TARGET_URLS`, `CRON_SCHEDULE`, etc.) if valid
3. Otherwise setup remains pending until form submission

## Prerequisites

- Node.js 20+
- npm 10+
- Google Cloud project
- Google Drive API enabled
- OAuth 2.0 credentials

## Google Cloud Setup

1. Create/select Google Cloud project.
2. Enable **Google Drive API**.
3. Configure OAuth consent screen.
4. Create OAuth 2.0 client credentials (Web application recommended for deployed callback).
5. Add authorized redirect URI matching your callback path, for example:
   - `https://screenshots.example.com/callback`

## Environment Variables

See [.env.example](/Users/goodboyengineering/projects/free-web-screenshots/.env.example).

### OAuth / app identity

- `GOOGLE_CLIENT_ID` (required)
- `GOOGLE_CLIENT_SECRET` (required)
- `GOOGLE_REDIRECT_URI` (required unless `OAUTH_SETUP_ENABLED=true` with valid `APP_BASE_URL`; then derived as `APP_BASE_URL + OAUTH_CALLBACK_PATH`)
- `GOOGLE_REFRESH_TOKEN` (optional if using setup flow + token file)
- `GOOGLE_TOKEN_FILE` (recommended; required for hosted setup)
- `GOOGLE_CREDENTIALS_FILE` (optional)

### Hosted setup controls

- `OAUTH_SETUP_ENABLED` (`true`/`false`)
- `APP_BASE_URL` (required when setup enabled)
- `OAUTH_SETUP_PATH` (default `/oauth/start`)
- `OAUTH_CALLBACK_PATH` (default `/callback`)
- `OAUTH_STATE_SECRET` (required when setup enabled; at least 32 chars)

### Dashboard login gate

- `APP_USER` (optional, must be paired with `APP_PASS`)
- `APP_PASS` (optional, must be paired with `APP_USER`)

### Runtime persistence

- `APP_RUNTIME_CONFIG_FILE` (default `/data/runtime-config.json`)
- `APP_RUNTIME_ENV_FILE` (default `/data/runtime.env`)

### Bootstrap defaults (used before first saved runtime config)

- `TARGET_URLS`
- `CRON_SCHEDULE`
- `SCREENSHOT_DIR`
- `PRE_SCREENSHOT_SCRIPT` (optional JavaScript executed in the page before screenshot)
- `SCREENSHOT_FULL_PAGE`
- `VIEWPORT_WIDTH`
- `VIEWPORT_HEIGHT`
- `PAGE_TIMEOUT_MS`
- `EXTRA_WAIT_MS`
- `DELETE_LOCAL_AFTER_UPLOAD`
- `RETRY_ATTEMPTS`
- `RETRY_BASE_DELAY_MS`
- `RETRY_MAX_DELAY_MS`
- `GOOGLE_DRIVE_MODE`
- `GOOGLE_DRIVE_FOLDER_ID`
- `LOG_LEVEL`
- `PORT`

## Local Development

```bash
npm install
cp .env.example .env
# edit .env
npm run dev -- --dry-run
npm run dev
```

## Runtime Modes

- `npm run dev` -> daemon mode
- `npm run dev -- --once` -> capture immediately once, then exit
- `npm run dev -- --dry-run` -> validate startup config
- `npm run dev -- --setup` -> setup server mode (no scheduler start)

## Custom Script Guide (Copy/Paste)

Use `PRE_SCREENSHOT_SCRIPT` in the web UI field:

- Setup screen: `PRE_SCREENSHOT_SCRIPT (optional browser JavaScript; return array for multi-shot)`
- Dashboard update screen: same field

The script runs inside the page before capture.

### Option A: One screenshot (default)

If your script does not return an array, the app captures one screenshot.

```js
window.scrollTo(0, 0);
document.querySelector("[data-accept-cookies]")?.click();
```

### Option B: Multiple screenshots in one session

Return an array of steps. The browser page stays open through all steps, then closes after the last screenshot.

```js
return [
  {
    name: "hero",
    actionScript: "window.scrollTo(0, 0);",
    waitMs: 300
  },
  {
    name: "features",
    actionScript: "document.querySelector('#features')?.scrollIntoView({ block: 'start' });",
    waitMs: 500
  },
  {
    name: "pricing",
    actionScript: "document.querySelector('#pricing')?.scrollIntoView({ block: 'start' });",
    waitMs: 500
  }
];
```

### Step fields (for multi-shot)

- `name` (optional): file suffix for that screenshot
- `actionScript` (optional): JavaScript string run before the screenshot
- `waitMs` (optional): additional wait before screenshot
- `fullPage` (optional): override full page capture for that step

### Context object available to scripts

Top-level script receives `context`:

```js
if (context.url.includes("example.com")) {
  window.scrollTo(0, 0);
}
```

Step `actionScript` receives:

- `context.url`
- `context.stepIndex`
- `context.stepName`

### Notes

- `name` is sanitized for filename safety.
- If `waitMs` is omitted, app uses `EXTRA_WAIT_MS`.
- If `fullPage` is omitted, app uses `SCREENSHOT_FULL_PAGE`.

## Docker

Build:

```bash
docker build -t free-web-screenshots:latest .
```

Run:

```bash
docker run -d \
  --name free-web-screenshots \
  --env-file .env \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  free-web-screenshots:latest
```

## docker-compose

```bash
docker compose up -d --build
```

Persist `./data` so token/config survive restarts.

## PM2 Setup and Deployment

### 1) One-time server setup

```bash
# from project root
npm install
npm run build
npx pm2 start ecosystem.config.cjs --env production
npx pm2 save
```

To auto-start PM2 on reboot:

```bash
npx pm2 startup
# run the command PM2 prints after this
npx pm2 save
```

### 2) Day-to-day process management

```bash
npm run status:pm2
npm run logs:pm2
npm run restart:pm2
npm run stop:pm2
```

### 3) Deploy updates with PM2

```bash
git pull
npm install
npm run build
npm run restart:pm2
```

First deploy still requires OAuth/runtime setup from the root URL (`/`) unless `GOOGLE_REFRESH_TOKEN` and runtime config are already present.

### 4) Nginx reverse proxy (`:80` -> `:8080`)

PM2 manages the Node.js process, but it does not proxy HTTP traffic. Keep the app on `127.0.0.1:8080`, and let Nginx listen on port `80`.

Example server block:

```nginx
server {
  listen 80;
  server_name screenshots.example.com; # or "_" if you are testing via server IP only

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Ubuntu/Debian enable flow:

```bash
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/free-web-screenshots
# create /etc/nginx/sites-available/free-web-screenshots with the server block above
sudo ln -sf /etc/nginx/sites-available/free-web-screenshots /etc/nginx/sites-enabled/free-web-screenshots
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

If you still see the Nginx welcome page, check these first:

- `server_name` mismatch: browsing by IP will not match `server_name screenshots.example.com`; use your real domain, or set `server_name _;` for IP-only testing.
- default site still enabled: make sure `/etc/nginx/sites-enabled/default` is removed.
- wrong vhost selected: run `sudo nginx -T | sed -n '/server_name/,/}/p'` and confirm your proxy block is loaded.

Optional hardening:

- Keep app bind as `127.0.0.1:8080` (not public `0.0.0.0`) when Nginx is on the same host
- Add TLS with Let's Encrypt (`certbot`) and redirect HTTP -> HTTPS

## Health Endpoint

`GET /health`

Response includes:

- `status` (`ok`, `setup_required`, `shutting_down`)
- run timestamps + duration
- aggregate run metrics
- `schedulerActive`

## Security Best Practices

- Keep `GOOGLE_DRIVE_MODE=appdata` unless visible folder is required
- Use HTTPS in production
- Protect root UI with `APP_USER` + strong `APP_PASS`
- Keep `OAUTH_STATE_SECRET` private and long
- Mount secrets/token files; do not commit them
- Keep `DELETE_LOCAL_AFTER_UPLOAD=true` unless local retention is required
- Consider disabling setup mode (`OAUTH_SETUP_ENABLED=false`) after initialization

## Troubleshooting

1. `Configuration error(s)` on startup:
   - Run `npm run dev -- --dry-run` and fix missing/invalid env values.
2. Root keeps showing setup form:
   - Ensure runtime settings were saved and `GOOGLE_TOKEN_FILE` contains `refresh_token`.
3. OAuth callback fails:
   - Verify `GOOGLE_REDIRECT_URI` exactly matches Google OAuth client settings.
4. No refresh token returned:
   - Revoke prior app access, re-run setup (OAuth uses `offline` + `consent`).
5. Visible-folder upload errors:
   - Verify `GOOGLE_DRIVE_FOLDER_ID` and account permissions.
6. Login keeps returning to `/login` even with correct credentials:
   - If you are on plain `http://`, ensure your app version includes request-aware cookie security (`Secure` only on HTTPS/X-Forwarded-Proto=https).
   - If using HTTPS behind Nginx, keep `proxy_set_header X-Forwarded-Proto $scheme;` in the server block.

## Testing

```bash
npm run lint
npm test
npm run build
```

## Limitations

- Single global schedule for all target URLs
- In-memory auth sessions (login sessions reset on process restart)
- Google Drive is the only implemented storage backend (interface is modular)

## License

MIT (`LICENSE`)
