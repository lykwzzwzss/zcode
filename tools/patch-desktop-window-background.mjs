#!/usr/bin/env node
/**
 * 修复 Windows 上 ZCode 启动时窗口顶部/右侧的黑色条带。
 *
 * 原因：主窗口在 win32 分支用 `backgroundColor: "#00000000"`（8 位 alpha 全透明）
 * 配 `frame: false`，但 Windows 不允许没有 `transparent: true` 的窗口做 alpha 合成，
 * 启动早期 renderer 还没画出根背景时，未绘制区域被合成为黑色。
 *
 * 修法：把 win32 分支的底色换成不透明 `#ffffffff`。两者长度相同，可以在 app.asar 里
 * 原位改写这些字节，不需要解包/重打包。renderer 加载后仍由它自己的根背景覆盖。
 *
 * 用法：
 *   node tools/patch-desktop-window-background.mjs --check  "C:/App/ZCode/resources/app.asar"
 *   node tools/patch-desktop-window-background.mjs --apply  "C:/App/ZCode/resources/app.asar"
 *
 * --apply 会先写一份 `<asar>.bak-blackbars-<时间戳>` 备份；改完需要重启 ZCode 生效。
 */
import { closeSync, copyFileSync, openSync, readSync, writeSync } from "node:fs";

const FROM = 'backgroundColor:"#00000000",frame:!1,backgroundMaterial:"acrylic"';
const TO = 'backgroundColor:"#ffffffff",frame:!1,backgroundMaterial:"acrylic"';
if (FROM.length !== TO.length) throw new Error("replacement must keep the same byte length");

const [, , mode, asarPath, ...rest] = process.argv;
if ((mode !== "--check" && mode !== "--apply") || !asarPath) {
  console.error("usage: node patch-desktop-window-background.mjs --check|--apply <app.asar>");
  process.exit(2);
}
const allowMultiple = rest.includes("--all");

const CHUNK = 1 << 20;
const OVERLAP = FROM.length;
const fd = openSync(asarPath, "r+");
const needle = Buffer.from(FROM);
const buffer = Buffer.alloc(CHUNK + OVERLAP);
const offsets = [];

let carry = 0;
let position = 0;
for (;;) {
  const read = readSync(fd, buffer, carry, CHUNK, position);
  if (read <= 0) break;
  const length = carry + read;
  for (let at = buffer.indexOf(needle, 0); at >= 0 && at < length; at = buffer.indexOf(needle, at + 1)) {
    offsets.push(position - carry + at);
  }
  carry = Math.min(OVERLAP, length);
  buffer.copy(buffer, 0, length - carry, length);
  position += read;
}

if (offsets.length === 0) {
  closeSync(fd);
  console.log("already patched, or the window chrome pattern is not present — nothing to do");
  process.exit(0);
}
console.log(`found ${offsets.length} site(s): ${offsets.join(", ")}`);

if (mode === "--check") {
  closeSync(fd);
  console.log("run with --apply to patch");
  process.exit(0);
}
if (offsets.length > 1 && !allowMultiple) {
  closeSync(fd);
  console.error("refusing to patch multiple sites; pass --all to override");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backupPath = `${asarPath}.bak-blackbars-${stamp}`;
closeSync(fd);
copyFileSync(asarPath, backupPath);
console.log(`backup -> ${backupPath}`);

const patchFd = openSync(asarPath, "r+");
for (const offset of offsets) writeSync(patchFd, Buffer.from(TO), 0, TO.length, offset);
closeSync(patchFd);
console.log("patched. restart ZCode to take effect.");
