import http, { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../logger";
import type { HealthState } from "./state";

export type AdditionalRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface StartHealthServerOptions {
  additionalRouteHandler?: AdditionalRouteHandler;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: HealthState,
  additionalRouteHandler?: AdditionalRouteHandler
): Promise<void> {
  if (!req.url) {
    writeJson(res, 400, { status: "error", error: "Missing URL" });
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (parsed.pathname === "/health") {
    const status = state.shuttingDown ? "shutting_down" : state.setupRequired ? "setup_required" : "ok";
    const statusCode = status === "ok" ? 200 : 503;

    writeJson(res, statusCode, {
      status,
      startedAt: state.startedAt,
      lastRunStartedAt: state.lastRunStartedAt,
      lastRunFinishedAt: state.lastRunFinishedAt,
      lastRunDurationMs: state.lastRunDurationMs,
      lastRunSuccess: state.lastRunSuccess,
      lastError: state.lastError,
      running: state.running,
      setupRequired: state.setupRequired,
      totalRuns: state.totalRuns,
      totalUrlSuccess: state.totalUrlSuccess,
      totalUrlFailure: state.totalUrlFailure,
      schedulerActive: state.schedulerActive
    });
    return;
  }

  if (additionalRouteHandler) {
    const handled = await additionalRouteHandler(req, res);
    if (handled) {
      return;
    }
  }

  writeJson(res, 404, { status: "not_found" });
}

export function startHealthServer(port: number, state: HealthState, options: StartHealthServerOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    void routeRequest(req, res, state, options.additionalRouteHandler).catch((error) => {
      logger.error({ err: error }, "Request handling failed");
      if (!res.headersSent) {
        writeJson(res, 500, { status: "error", error: "internal_error" });
      }
    });
  });

  server.listen(port, () => {
    logger.info({ port }, "HTTP server listening");
  });
  return server;
}
