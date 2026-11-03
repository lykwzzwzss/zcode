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

export function personalReleaseVersion(version, date, revision) {
  const base = /^(\d+\.\d+\.\d+)(?:-\d{8}(?:\.v\d+)?)?$/.exec(version);
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
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 2)) {
    throw new Error("Expected a same-day release revision of at least 2");
  }
  return `${base[1]}-${date}${revision === undefined ? "" : `.v${revision}`}`;
}

export async function stampPersonalReleaseVersion(root, date = beijingBuildDate(), revision) {
  const path = resolve(root, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = personalReleaseVersion(manifest.version, date, revision);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!["--date", "--revision"].includes(flag) || value === undefined || options.has(flag))
      throw new Error("Usage: pnpm version:personal [--date YYYYMMDD] [--revision N]");
    options.set(flag, value);
  }
  console.log(
    await stampPersonalReleaseVersion(
      resolve(import.meta.dirname, ".."),
      options.get("--date"),
      options.has("--revision") ? Number(options.get("--revision")) : undefined,
    ),
  );
}
