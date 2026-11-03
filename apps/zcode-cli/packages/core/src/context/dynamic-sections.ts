import type { ContextSection } from "./types.js";
import { estimateTokens } from "./utils.js";

const COMMUNICATION_PROMPT =
  "Write code that reads like the surrounding code: match its comment density, naming, and idiom.";

const PRONOUNS_PROMPT =
  "When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.";

const ACTION_CAUTION_PROMPT =
  "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.";

const CONTEXT_MANAGEMENT_PROMPT = [
  "# Context management",
  "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue \u2014 you don't need to wrap up early or hand off mid-task.",
  "",
  "Four tools manage this session's context. Folded text is never deleted \u2014 it stays in the durable transcript \u2014 so folding is recoverable, not destructive:",
  "- CompactStatus \u2014 list the compaction boundaries: how many messages were folded, token counts before and after, when, and what triggered it. Check it when you are unsure whether something has already been folded.",
  "- SearchContext \u2014 search the durable transcript by keyword, including messages that were folded away; hits from folded ranges are marked (folded). Use it before assuming a detail is gone.",
  "- DecompressContext \u2014 restore the original text of a folded range (or explicit message ids) into the conversation. Search first, then restore only the range you need.",
  "- CompactNow \u2014 ask the runtime to fold the conversation at the next safe point. Put the files, decisions, and exact strings that must survive into instructions; fold when most of the current context is already-consumed work.",
  "Prefer these over re-deriving or re-asking: a detail SearchContext can find is not lost.",
  "Compaction summaries form a recursive hierarchy. CompactNow ranges may include persisted summary ids; unchanged context outside the range stays in place. CompactStatus exposes level and childBoundaryIds; pass boundaryId to browse its children, or DecompressContext tier=summary to inspect that node before retrieving originals.",
  "SearchContext, CompactStatus and DecompressContext can return nextCursor. Continue with the same selection and filters plus cursor until no nextCursor remains. DecompressContext pages contain complete original text chunks, including long tool output. toFile writes only the current page; use separate file paths for continuation pages.",
].join("\n");

const ACT_DONT_REDERIVE_PROMPT =
  "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey";

export function buildSessionGuidanceSection(
  toolNames: readonly string[],
  hasSkills = false,
): ContextSection | null {
  const tools = new Set(toolNames);
  const lines = ["# Session-specific guidance"];

  // 当前不输出 Agent 指导段。
  // if (tools.has("Agent")) {
  //   lines.push("- Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.");

  //   let exploreGuide = "- For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore.";
  //   const fallbackSearch = getDirectSearchGuidance(tools);
  //   if (fallbackSearch) {
  //     exploreGuide += ` Otherwise use ${fallbackSearch} directly.`;
  //   }
  //   lines.push(exploreGuide);
  // }

  if (tools.has("Skill") && hasSkills) {
    lines.push(
      " - When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section \u2014 don't guess.",
    );
  }

  // if (tools.has("AskUserQuestion")) {
  //   lines.push("- Use AskUserQuestion when you need a bounded clarification before proceeding.");
  // }

  if (lines.length <= 1) {
    return null;
  }

  // 只有存在实际 session guidance 时才输出本段，避免向 simple branch 注入空标题。
  return createDynamicSection("Session-specific guidance", "session_guidance", lines.join("\n"));
}

export function buildDynamicBehaviorSection(): ContextSection {
  return createDynamicSection(
    "Dynamic Behavior",
    "dynamic_behavior",
    [COMMUNICATION_PROMPT, PRONOUNS_PROMPT, ACTION_CAUTION_PROMPT].join("\n\n"),
  );
}

export function buildContextManagementSection(): ContextSection {
  return createDynamicSection(
    "Context Management",
    "context_management",
    [CONTEXT_MANAGEMENT_PROMPT, ACT_DONT_REDERIVE_PROMPT].join("\n\n"),
  );
}

function createDynamicSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
