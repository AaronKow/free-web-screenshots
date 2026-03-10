# free-web-screenshots

Production-minded Node.js service that captures screenshots of one or more websites on a schedule and uploads them to Google Drive.

## What This App Does

- Runs continuously with an in-app cron scheduler (default: every hour).
- Captures screenshots with Playwright + Chromium for each URL in `TARGET_URLS`.
- Waits for page stability (`networkidle`) and optional extra delay.
- Uploads screenshots to Google Drive via official `googleapis` client.
- Exposes `/health` endpoint for container health checks.
- Supports:
  - daemon mode (scheduled)
  - one-shot mode (`--once`)
  - config validation mode (`--dry-run`)

## Security Model (Default and Recommended)

### Default mode: `appdata`

By default, the app uploads into Google Drive **Application Data folder** using scope:

- `https://www.googleapis.com/auth/drive.appdata`

This is the most restrictive mode in this project and is strongly recommended.

Important behavior:

- Files are written to hidden `appDataFolder`.
- This folder is **not visible in normal Google Drive UI**.
- Data is accessible only through the app/API with authorized credentials.

### Optional mode: `visible-folder`

If you explicitly set `GOOGLE_DRIVE_MODE=visible-folder`, the app uploads to a specific folder ID (`GOOGLE_DRIVE_FOLDER_ID`) using:

- `https://www.googleapis.com/auth/drive.file`

Tradeoff:

- Less restrictive than `appdata`.
- Not strict write-only semantics.
- Data is in visible Drive space and operational risk is higher.

The app does **not** use broad full-Drive scope.

## Prerequisites

- Node.js 20 LTS or newer
- npm 10+
- Google Cloud project with Drive API enabled
- OAuth 2.0 client credentials
- A valid refresh token
- Linux server/VPS (recommended for continuous operation)

## Project Structure

- `src/config` - env parsing and validation
- `src/services` - screenshot workflow
- `src/storage` - pluggable uploader interface + Google Drive implementation
- `src/scheduler` - cron orchestration
- `src/health` - health state + HTTP endpoint
- `src/logger` - structured logs
- `src/utils` - retry and filename utilities
- `test` - unit tests

## Environment Variables

See `.env.example` for full list.

Required in normal operation:

- `TARGET_URLS`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_REFRESH_TOKEN` (or token file mode)

Main options:

- `CRON_SCHEDULE` default: `0 * * * *`
- `SCREENSHOT_DIR` default: `/tmp/screenshots`
- `SCREENSHOT_FULL_PAGE` default: `false`
- `VIEWPORT_WIDTH` default: `1366`
- `VIEWPORT_HEIGHT` default: `768`
- `PAGE_TIMEOUT_MS` default: `30000`
- `EXTRA_WAIT_MS` default: `0`
- `DELETE_LOCAL_AFTER_UPLOAD` default: `true`
- `GOOGLE_DRIVE_MODE` default: `appdata`
- `GOOGLE_DRIVE_FOLDER_ID` required only for `visible-folder`
- `LOG_LEVEL` default: `info`
- `PORT` default: `8080`

Retry tuning:

- `RETRY_ATTEMPTS` default: `3`
- `RETRY_BASE_DELAY_MS` default: `1000`
- `RETRY_MAX_DELAY_MS` default: `10000`

Optional file-based secret loading:

- `GOOGLE_CREDENTIALS_FILE` JSON with `client_id`, `client_secret`, `redirect_uri`
- `GOOGLE_TOKEN_FILE` JSON with `refresh_token` (and token persistence)

## Google Cloud Setup

1. Create/select a Google Cloud project.
2. Enable API:
   - Google Drive API
3. Configure OAuth consent screen.
4. Create OAuth client credentials (Desktop app or Web app).
5. Save:
   - client ID
   - client secret
   - redirect URI

## OAuth Setup and Refresh Token (Safe Flow)

Use OAuth 2.0 authorization code flow and request only required scope.

Default secure mode scope:

- `https://www.googleapis.com/auth/drive.appdata`

Optional visible-folder mode scope:

- `https://www.googleapis.com/auth/drive.file`

Suggested safe method:

1. Build an auth URL with your client credentials and the intended scope.
2. Complete consent in browser.
3. Exchange auth code for tokens server-side.
4. Store only refresh token in:
   - environment variable (`GOOGLE_REFRESH_TOKEN`) or
   - mounted token file (`GOOGLE_TOKEN_FILE`) with strict file permissions.

Never commit tokens or credentials to source control.

## Local Development

```bash
npm install
cp .env.example .env
# edit .env with real values
```

Validate config only:

```bash
npm run dev -- --dry-run
```

Run one-shot capture:

```bash
npm run dev -- --once
```

Run daemon scheduler:

```bash
npm run dev
```

Build + run production JS:

```bash
npm run build
npm start
```

## Docker

Build image:

```bash
docker build -t free-web-screenshots:latest .
```

Run container:

```bash
docker run -d \
  --name free-web-screenshots \
  --env-file .env \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  free-web-screenshots:latest
```

Health endpoint:

- `GET /health`

Container includes Docker `HEALTHCHECK` against `/health`.

## docker-compose

```bash
docker compose up -d --build
```

Example persists only runtime data under `./data` (screenshots temp files and token file if used).

## VPS Deployment Notes

- Use a dedicated low-privilege OS user.
- Keep `.env` and secret files readable only by service user.
- Prefer mounted secret files over baking secrets into images.
- Restrict inbound network to required management and app ports.
- Keep host and container base image updated.
- Run behind reverse proxy/firewall if exposing `/health` publicly.

## Runtime Modes

- `node dist/src/index.js` -> daemon mode (scheduled)
- `node dist/src/index.js --once` -> run now and exit
- `node dist/src/index.js --dry-run` -> validate configuration and exit

Startup misconfiguration exits non-zero.

## Logging

Structured JSON logs to stdout with pino.

- Per-URL success/failure is logged each run.
- Secrets/tokens are redacted.
- Access tokens, refresh tokens, client secrets, and auth headers are never logged intentionally.

## Testing

Run unit tests:

```bash
npm test
```

Tests included:

- config validation behavior
- URL-safe filename generation with UTC timestamps

## Security Best Practices

- Keep default `GOOGLE_DRIVE_MODE=appdata`.
- Use least-privilege scope only.
- Do not grant broad Drive scopes.
- Rotate OAuth credentials periodically.
- Use private networks and hardened host OS.
- Keep token files out of git and image layers.
- Set `DELETE_LOCAL_AFTER_UPLOAD=true` unless you need local retention.

## Troubleshooting

1. `Configuration error(s)` on startup:
   - run `--dry-run`, check required env vars and cron syntax.
2. OAuth failures (`invalid_grant`, `unauthorized_client`):
   - verify redirect URI, consent screen, refresh token validity, and scope alignment.
3. Upload fails in `visible-folder` mode:
   - verify folder ID and account access.
4. Browser launch failures in containers:
   - rebuild image and ensure Chromium dependencies are installed.
5. `/health` returns 503:
   - process is shutting down after signal.

## Limitations

- Captures only Chromium screenshots (no PDF/export variants).
- Dynamic pages that never settle may rely on timeout fallback.
- Current storage backend is Google Drive only (interface allows future backends).
- Per-URL schedule granularity is not supported (single global schedule).

## License

MIT (see `LICENSE`).
