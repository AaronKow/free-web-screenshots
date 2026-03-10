import pino, { LoggerOptions } from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const options: LoggerOptions = {
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "googleClientSecret",
      "googleRefreshToken",
      "access_token",
      "refresh_token",
      "authorization",
      "headers.authorization"
    ],
    censor: "[REDACTED]"
  }
};

export const logger = pino(options);
