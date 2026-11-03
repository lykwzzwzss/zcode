import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beijingBuildDate,
  personalReleaseVersion,
  stampPersonalReleaseVersion,
} from "../personal-release-version.mjs";

test("personal version follows the upstream base and replaces the date suffix", () => {
  assert.equal(personalReleaseVersion("3.17.1", "20261103"), "3.17.1-20261103");
  assert.equal(personalReleaseVersion("3.17.1-20261102", "20261103"), "3.17.1-20261103");
  assert.equal(personalReleaseVersion("3.18.0", "20261103"), "3.18.0-20261103");
  assert.throws(() => personalReleaseVersion("3.17.1", "20260230"));
  assert.throws(() => personalReleaseVersion("3.17.1", "20261303"));
  assert.throws(() => personalReleaseVersion("3.17.1", "2026-11-03"));
  assert.throws(() => personalReleaseVersion("3.17.1-beta", "20261103"));
});
test("build date uses Beijing midnight across UTC dates", () => {
  assert.equal(beijingBuildDate(new Date("2026-11-02T15:59:59Z")), "20261102");
  assert.equal(beijingBuildDate(new Date("2026-11-02T16:00:00Z")), "20261103");
});

test("same-day releases use revision suffixes without changing the upstream base", () => {
  assert.equal(personalReleaseVersion("3.17.1-20261103", "20261103", 2), "3.17.1-20261103.v2");
  assert.equal(personalReleaseVersion("3.17.1-20261103.v2", "20261103", 3), "3.17.1-20261103.v3");
  assert.equal(personalReleaseVersion("3.17.1-20261103.v3", "20261104"), "3.17.1-20261104");
  for (const invalid of [0, 1, -1, 2.5, NaN, Infinity, "2"])
    assert.throws(() => personalReleaseVersion("3.17.1", "20261103", invalid));
});
test("stamping the root manifest is repeatable and preserves other fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "zcode", version: "3.17.1", scripts: { build: "unchanged" } }),
  );
  await stampPersonalReleaseVersion(root, "20261103");
  const first = await readFile(join(root, "package.json"), "utf8");
  await stampPersonalReleaseVersion(root, "20261103");
  assert.equal(await readFile(join(root, "package.json"), "utf8"), first);
  assert.deepEqual(JSON.parse(first), {
    name: "zcode",
    version: "3.17.1-20261103",
    scripts: { build: "unchanged" },
  });
});
