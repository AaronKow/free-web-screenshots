import crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";
import type { AppConfig } from "../config";
import type { HealthState } from "../health/state";
import type { RuntimeSettings, RuntimeSettingsInput } from "../runtime/settings";
import { buildDefaultRuntimeSettings, parseRuntimeSettingsInput, runtimeSettingsToInput } from "../runtime/settings";

interface DashboardMetrics {
  totalRuns: number;
  totalUrlSuccess: number;
  totalUrlFailure: number;
  schedulerActive: boolean;
}

interface ControlPlaneDeps {
  config: AppConfig;
  healthState: HealthState;
  getRuntimeSettings: () => RuntimeSettings | undefined;
  getHasRefreshToken: () => boolean;
  getMetrics: () => DashboardMetrics;
  saveSettings: (settings: RuntimeSettings) => Promise<void>;
  restartScheduler: () => Promise<void>;
  triggerScreenshotNow: () => Promise<void>;
  getOauthAuthorizationUrl: () => string;
}

interface SessionRecord {
  user: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function isHttpsRequest(req: IncomingMessage): boolean {
  const encrypted = (req.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted;
  if (encrypted) return true;
  const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
  return forwardedProto === "https";
}

function setCookie(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  value: string,
  maxAgeSec: number
): void {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${name}=${value}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

function clearCookie(res: ServerResponse, name: string): void {
  res.setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  return raw.split(";").reduce<Record<string, string>>((acc, pair) => {
    const [k, ...rest] = pair.trim().split("=");
    acc[k] = rest.join("=");
    return acc;
  }, {});
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#0f172a;--muted:#475569;--accent:#0b6bcb;--line:#dbe4f0;--ok:#0f766e;--warn:#b45309}
*{box-sizing:border-box} body{margin:0;font-family:ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial;background:radial-gradient(circle at 20% 0%,#e8f1ff 0%,var(--bg) 45%);color:var(--ink)}
.wrap{max-width:980px;margin:34px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 10px 30px rgba(15,23,42,.06);margin-bottom:16px}
h1{margin:0 0 8px;font-size:28px} p{color:var(--muted);margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.full{grid-column:1/-1}
label{font-size:13px;color:var(--muted);display:block;margin-bottom:6px}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;font-size:14px}
textarea{min-height:72px;resize:vertical}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
button,a.btn{border:0;background:var(--accent);color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;cursor:pointer;font-weight:600}
button.secondary,a.secondary{background:#1e293b}
.badge{display:inline-block;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#e2f5f2;color:var(--ok)}
.warn{background:#fff2dd;color:var(--warn)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#334155}
@media (max-width:760px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function buildNoticeRedirect(message: string, type: "success" | "error"): string {
  const params = new URLSearchParams({
    notice: message,
    noticeType: type
  });
  return `/?${params.toString()}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function createControlPlaneHandler(deps: ControlPlaneDeps) {
  const sessions = new Map<string, SessionRecord>();

  function authenticated(req: IncomingMessage): boolean {
    if (!deps.config.appUser || !deps.config.appPass) {
      return true;
    }

    const token = parseCookies(req).app_session;
    if (!token) return false;
    const record = sessions.get(token);
    if (!record) return false;
    if (record.expiresAt < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (authenticated(req)) {
      return true;
    }
    res.writeHead(302, { location: "/login" });
    res.end();
    return false;
  }

  function renderLogin(error?: string): string {
    return htmlPage(
      "Login",
      `<div class="card"><h1>Secure Access</h1><p>Authenticate to access setup and dashboard.</p>
      ${error ? `<p class="badge warn">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/login"><div class="grid">
      <div><label>Username (APP_USER)</label><input name="username" required /></div>
      <div><label>Password (APP_PASS)</label><input type="password" name="password" required /></div>
      </div><div class="btns"><button type="submit">Login</button></div></form></div>`
    );
  }

  function renderForm(settingsInput: RuntimeSettingsInput, error?: string, notice?: string, noticeType?: string): string {
    return htmlPage(
      "Setup",
      `<div class="card"><h1>Initial Setup</h1><p>Configure screenshot behavior, then initialize OAuth.</p>
      ${notice ? `<p class="badge ${noticeType === "error" ? "warn" : ""}">${escapeHtml(notice)}</p>` : ""}
      ${error ? `<p class="badge warn">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/setup/save"><div class="grid">
      <div class="full"><label>TARGET_URLS (comma-separated)</label><textarea name="targetUrls" required>${escapeHtml(settingsInput.targetUrls)}</textarea></div>
      <div class="full"><label>PRE_SCREENSHOT_SCRIPT (optional browser JavaScript; return array for multi-shot)</label><textarea name="preScreenshotScript" placeholder="return [{ name: 'hero', actionScript: \"window.scrollTo(0, 0)\", waitMs: 400 }, { name: 'pricing', actionScript: \"document.querySelector('#pricing')?.scrollIntoView()\", waitMs: 600 }];">${escapeHtml(settingsInput.preScreenshotScript)}</textarea></div>
      <div><label>CRON_SCHEDULE</label><input name="cronSchedule" value="${escapeHtml(settingsInput.cronSchedule)}" required /></div>
      <div><label>SCREENSHOT_DIR</label><input name="screenshotDir" value="${escapeHtml(settingsInput.screenshotDir)}" required /></div>
      <div><label>SCREENSHOT_FULL_PAGE</label><select name="screenshotFullPage"><option value="false" ${settingsInput.screenshotFullPage === "false" ? "selected" : ""}>false</option><option value="true" ${settingsInput.screenshotFullPage === "true" ? "selected" : ""}>true</option></select></div>
      <div><label>VIEWPORT_WIDTH</label><input name="viewportWidth" value="${escapeHtml(settingsInput.viewportWidth)}" required /></div>
      <div><label>VIEWPORT_HEIGHT</label><input name="viewportHeight" value="${escapeHtml(settingsInput.viewportHeight)}" required /></div>
      <div><label>PAGE_TIMEOUT_MS</label><input name="pageTimeoutMs" value="${escapeHtml(settingsInput.pageTimeoutMs)}" required /></div>
      <div><label>EXTRA_WAIT_MS</label><input name="extraWaitMs" value="${escapeHtml(settingsInput.extraWaitMs)}" required /></div>
      <div><label>DELETE_LOCAL_AFTER_UPLOAD</label><select name="deleteLocalAfterUpload"><option value="true" ${settingsInput.deleteLocalAfterUpload === "true" ? "selected" : ""}>true</option><option value="false" ${settingsInput.deleteLocalAfterUpload === "false" ? "selected" : ""}>false</option></select></div>
      <div><label>RETRY_ATTEMPTS</label><input name="retryAttempts" value="${escapeHtml(settingsInput.retryAttempts)}" required /></div>
      <div><label>RETRY_BASE_DELAY_MS</label><input name="retryBaseDelayMs" value="${escapeHtml(settingsInput.retryBaseDelayMs)}" required /></div>
      <div><label>RETRY_MAX_DELAY_MS</label><input name="retryMaxDelayMs" value="${escapeHtml(settingsInput.retryMaxDelayMs)}" required /></div>
      <div><label>GOOGLE_DRIVE_MODE</label><select name="googleDriveMode"><option value="appdata" ${settingsInput.googleDriveMode === "appdata" ? "selected" : ""}>appdata (recommended)</option><option value="visible-folder" ${settingsInput.googleDriveMode === "visible-folder" ? "selected" : ""}>visible-folder</option></select></div>
      <div><label>GOOGLE_DRIVE_FOLDER_ID (optional unless visible-folder)</label><input name="googleDriveFolderId" value="${escapeHtml(settingsInput.googleDriveFolderId)}" /></div>
      </div><div class="btns"><button type="submit">Proceed and Initialize</button></div></form></div>`
    );
  }

  function renderDashboard(
    settings: RuntimeSettings,
    metrics: DashboardMetrics,
    hasRefreshToken: boolean,
    notice?: string,
    noticeType?: string
  ): string {
    const settingsInput = runtimeSettingsToInput(settings);

    return htmlPage(
      "Dashboard",
      `<div class="card"><h1>Screenshot Dashboard</h1>
      <p>Runtime status and scheduler controls.</p>
      ${notice ? `<p><span class="badge ${noticeType === "error" ? "warn" : ""}">${escapeHtml(notice)}</span></p>` : ""}
      <p><span class="badge ${hasRefreshToken ? "" : "warn"}">${hasRefreshToken ? "OAuth ready" : "OAuth setup required"}</span></p>
      <div class="grid">
      <div><label>Total Runs</label><div class="mono">${metrics.totalRuns}</div></div>
      <div><label>Total URL Success</label><div class="mono">${metrics.totalUrlSuccess}</div></div>
      <div><label>Total URL Failure</label><div class="mono">${metrics.totalUrlFailure}</div></div>
      <div><label>Scheduler Active</label><div class="mono">${metrics.schedulerActive}</div></div>
      </div>
      <div class="btns">
        <form method="post" action="/screenshot/now"><button type="submit">Screenshot Now</button></form>
        <form method="post" action="/scheduler/restart"><button class="secondary" type="submit">Restart Scheduler</button></form>
        <a class="btn secondary" href="/logout">Logout</a>
      </div>
      </div>
      <div class="card"><h1>Update Configuration</h1><p>Save and restart worker with new settings.</p>
      <form method="post" action="/setup/save"><div class="grid">
      <div class="full"><label>TARGET_URLS</label><textarea name="targetUrls" required>${escapeHtml(settingsInput.targetUrls)}</textarea></div>
      <div class="full"><label>PRE_SCREENSHOT_SCRIPT (optional browser JavaScript; return array for multi-shot)</label><textarea name="preScreenshotScript" placeholder="return [{ name: 'hero', actionScript: \"window.scrollTo(0, 0)\", waitMs: 400 }, { name: 'pricing', actionScript: \"document.querySelector('#pricing')?.scrollIntoView()\", waitMs: 600 }];">${escapeHtml(settingsInput.preScreenshotScript)}</textarea></div>
      <div><label>CRON_SCHEDULE</label><input name="cronSchedule" value="${escapeHtml(settingsInput.cronSchedule)}" required /></div>
      <div><label>SCREENSHOT_DIR</label><input name="screenshotDir" value="${escapeHtml(settingsInput.screenshotDir)}" required /></div>
      <div><label>SCREENSHOT_FULL_PAGE</label><select name="screenshotFullPage"><option value="false" ${settingsInput.screenshotFullPage === "false" ? "selected" : ""}>false</option><option value="true" ${settingsInput.screenshotFullPage === "true" ? "selected" : ""}>true</option></select></div>
      <div><label>VIEWPORT_WIDTH</label><input name="viewportWidth" value="${escapeHtml(settingsInput.viewportWidth)}" required /></div>
      <div><label>VIEWPORT_HEIGHT</label><input name="viewportHeight" value="${escapeHtml(settingsInput.viewportHeight)}" required /></div>
      <div><label>PAGE_TIMEOUT_MS</label><input name="pageTimeoutMs" value="${escapeHtml(settingsInput.pageTimeoutMs)}" required /></div>
      <div><label>EXTRA_WAIT_MS</label><input name="extraWaitMs" value="${escapeHtml(settingsInput.extraWaitMs)}" required /></div>
      <div><label>DELETE_LOCAL_AFTER_UPLOAD</label><select name="deleteLocalAfterUpload"><option value="true" ${settingsInput.deleteLocalAfterUpload === "true" ? "selected" : ""}>true</option><option value="false" ${settingsInput.deleteLocalAfterUpload === "false" ? "selected" : ""}>false</option></select></div>
      <div><label>RETRY_ATTEMPTS</label><input name="retryAttempts" value="${escapeHtml(settingsInput.retryAttempts)}" required /></div>
      <div><label>RETRY_BASE_DELAY_MS</label><input name="retryBaseDelayMs" value="${escapeHtml(settingsInput.retryBaseDelayMs)}" required /></div>
      <div><label>RETRY_MAX_DELAY_MS</label><input name="retryMaxDelayMs" value="${escapeHtml(settingsInput.retryMaxDelayMs)}" required /></div>
      <div><label>GOOGLE_DRIVE_MODE</label><select name="googleDriveMode"><option value="appdata" ${settingsInput.googleDriveMode === "appdata" ? "selected" : ""}>appdata</option><option value="visible-folder" ${settingsInput.googleDriveMode === "visible-folder" ? "selected" : ""}>visible-folder</option></select></div>
      <div><label>GOOGLE_DRIVE_FOLDER_ID</label><input name="googleDriveFolderId" value="${escapeHtml(settingsInput.googleDriveFolderId)}" /></div>
      </div><div class="btns"><button type="submit">Save and Restart Scheduler</button></div></form></div>`
    );
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderLogin());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/login") {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const username = (form.get("username") || "").trim();
      const password = form.get("password") || "";

      if (!deps.config.appUser || !deps.config.appPass) {
        res.writeHead(302, { location: "/" });
        res.end();
        return true;
      }

      if (username !== deps.config.appUser || password !== deps.config.appPass) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end(renderLogin("Invalid username or password"));
        return true;
      }

      const token = crypto.randomBytes(24).toString("base64url");
      sessions.set(token, { user: username, expiresAt: Date.now() + SESSION_TTL_MS });
      setCookie(req, res, "app_session", token, Math.floor(SESSION_TTL_MS / 1000));
      res.writeHead(302, { location: "/" });
      res.end();
      return true;
    }

    if (req.method === "GET" && url.pathname === "/logout") {
      const token = parseCookies(req).app_session;
      if (token) sessions.delete(token);
      clearCookie(res, "app_session");
      res.writeHead(302, { location: "/login" });
      res.end();
      return true;
    }

    if (req.method === "GET" && url.pathname === "/") {
      if (!requireAuth(req, res)) return true;

      const settings = deps.getRuntimeSettings();
      const hasRefreshToken = deps.getHasRefreshToken();
      const notice = (url.searchParams.get("notice") || "").trim();
      const noticeType = (url.searchParams.get("noticeType") || "success").trim();

      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!settings || !hasRefreshToken) {
        const input = runtimeSettingsToInput(settings || buildDefaultRuntimeSettings());
        res.end(renderForm(input, undefined, notice, noticeType));
        return true;
      }

      res.end(renderDashboard(settings, deps.getMetrics(), hasRefreshToken, notice, noticeType));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/setup/save") {
      if (!requireAuth(req, res)) return true;

      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const parsed = parseRuntimeSettingsInput({
        targetUrls: form.get("targetUrls") || "",
        preScreenshotScript: form.get("preScreenshotScript") || "",
        cronSchedule: form.get("cronSchedule") || "",
        screenshotDir: form.get("screenshotDir") || "",
        screenshotFullPage: form.get("screenshotFullPage") || "false",
        viewportWidth: form.get("viewportWidth") || "",
        viewportHeight: form.get("viewportHeight") || "",
        pageTimeoutMs: form.get("pageTimeoutMs") || "",
        extraWaitMs: form.get("extraWaitMs") || "",
        deleteLocalAfterUpload: form.get("deleteLocalAfterUpload") || "true",
        retryAttempts: form.get("retryAttempts") || "",
        retryBaseDelayMs: form.get("retryBaseDelayMs") || "",
        retryMaxDelayMs: form.get("retryMaxDelayMs") || "",
        googleDriveMode: form.get("googleDriveMode") || "appdata",
        googleDriveFolderId: form.get("googleDriveFolderId") || ""
      });

      if (!parsed.value) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(renderForm({
          targetUrls: form.get("targetUrls") || "",
          preScreenshotScript: form.get("preScreenshotScript") || "",
          cronSchedule: form.get("cronSchedule") || "",
          screenshotDir: form.get("screenshotDir") || "",
          screenshotFullPage: form.get("screenshotFullPage") || "false",
          viewportWidth: form.get("viewportWidth") || "",
          viewportHeight: form.get("viewportHeight") || "",
          pageTimeoutMs: form.get("pageTimeoutMs") || "",
          extraWaitMs: form.get("extraWaitMs") || "",
          deleteLocalAfterUpload: form.get("deleteLocalAfterUpload") || "true",
          retryAttempts: form.get("retryAttempts") || "",
          retryBaseDelayMs: form.get("retryBaseDelayMs") || "",
          retryMaxDelayMs: form.get("retryMaxDelayMs") || "",
          googleDriveMode: form.get("googleDriveMode") || "appdata",
          googleDriveFolderId: form.get("googleDriveFolderId") || ""
        }, parsed.errors.join("; ")));
        return true;
      }

      await deps.saveSettings(parsed.value);

      if (!deps.getHasRefreshToken()) {
        res.writeHead(302, { location: deps.config.oauthSetupPath });
        res.end();
        return true;
      }

      await deps.restartScheduler();
      res.writeHead(302, { location: "/" });
      res.end();
      return true;
    }

    if (req.method === "POST" && url.pathname === "/scheduler/restart") {
      if (!requireAuth(req, res)) return true;
      await deps.restartScheduler();
      res.writeHead(302, { location: "/" });
      res.end();
      return true;
    }

    if (req.method === "POST" && url.pathname === "/screenshot/now") {
      if (!requireAuth(req, res)) return true;
      try {
        await deps.triggerScreenshotNow();
        res.writeHead(302, { location: buildNoticeRedirect("Screenshot run completed successfully.", "success") });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Screenshot run failed";
        res.writeHead(302, { location: buildNoticeRedirect(`Screenshot run failed: ${message}`, "error") });
      }
      res.end();
      return true;
    }

    if (req.method === "GET" && url.pathname === deps.config.oauthSetupPath) {
      if (!requireAuth(req, res)) return true;
      res.writeHead(302, { location: deps.getOauthAuthorizationUrl() });
      res.end();
      return true;
    }

    return false;
  };
}
