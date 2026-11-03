/**
 * native-context-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { buildContextFold } from "./contract.js";

export function foldTwoMessages() {
  return buildContextFold([
    { messageId: "msg_one", message: { role: "user", content: "Decision" } },
    { messageId: "msg_two", message: { role: "assistant", content: "Evidence" } },
  ]);
}
