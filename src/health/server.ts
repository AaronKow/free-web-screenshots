import http, { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../logger";
import type { HealthState } from "./state";

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function routeRequest(req: IncomingMessage, res: ServerResponse, state: HealthState): void {
  if (!req.url) {
    writeJson(res, 400, { status: "error", error: "Missing URL" });
    return;
  }

  if (req.url === "/health") {
    const statusCode = state.shuttingDown ? 503 : 200;
    writeJson(res, statusCode, {
      status: state.shuttingDown ? "shutting_down" : "ok",
      startedAt: state.startedAt,
      lastRunStartedAt: state.lastRunStartedAt,
      lastRunFinishedAt: state.lastRunFinishedAt,
      lastRunSuccess: state.lastRunSuccess,
      lastError: state.lastError,
      running: state.running
    });
    return;
  }

  writeJson(res, 404, { status: "not_found" });
}

export function startHealthServer(port: number, state: HealthState): http.Server {
  const server = http.createServer((req, res) => routeRequest(req, res, state));
  server.listen(port, () => {
    logger.info({ port }, "Health server listening");
  });
  return server;
}
