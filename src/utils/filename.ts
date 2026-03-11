import path from "node:path";

const MAX_BASENAME_LENGTH = 180;

function sanitizePart(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .toLowerCase();
}

function utcTimestamp(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildScreenshotFilename(url: string, date = new Date()): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL for filename generation: ${url}`);
  }

  const host = sanitizePart(parsed.hostname) || "unknown-host";
  const pathPart = sanitizePart(parsed.pathname.replace(/\//g, "-")) || "root";
  const ts = utcTimestamp(date);

  const base = `${host}__${pathPart}__${ts}`;
  const trimmedBase = base.slice(0, MAX_BASENAME_LENGTH);
  const safe = trimmedBase || "screenshot";

  return `${safe}.avif`;
}

export function buildScreenshotPath(dir: string, filename: string): string {
  const safe = sanitizePart(path.basename(filename, path.extname(filename)));
  return path.join(dir, `${safe || "screenshot"}.avif`);
}
