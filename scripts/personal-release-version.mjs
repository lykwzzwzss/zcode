import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function beijingBuildDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type).value)
    .join("");
}

export function personalReleaseVersion(version, date) {
  const base = /^(\d+\.\d+\.\d+)(?:-\d{8})?$/.exec(version);
  if (!base)
    throw new Error("Expected an upstream stable version or an existing personal date version");
  const parsed = /^\d{8}$/.test(date)
    ? new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`)
    : new Date(NaN);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10).replaceAll("-", "") !== date
  ) {
    throw new Error("Expected a valid build date in YYYYMMDD format");
  }
  return `${base[1]}-${date}`;
}

export async function stampPersonalReleaseVersion(root, date = beijingBuildDate()) {
  const path = resolve(root, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = personalReleaseVersion(manifest.version, date);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--date")) {
    throw new Error("Usage: pnpm version:personal [--date YYYYMMDD]");
  }
  console.log(await stampPersonalReleaseVersion(resolve(import.meta.dirname, ".."), args[1]));
}
