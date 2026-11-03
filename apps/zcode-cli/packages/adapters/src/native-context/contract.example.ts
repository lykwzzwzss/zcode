/**
 * native-context-adapters 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { DatabaseSync } from "node:sqlite";
import { createSqliteContextArchive } from "./contract.js";

export function attachArchive(db: DatabaseSync) {
  return createSqliteContextArchive(db);
}
