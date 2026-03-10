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
- `GOOGLE_REDIRECT_URI` (required)
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
