const OPENCODE_ROOT_DOMAIN = "opencode.ai";
const OPENCODE_GO_PATH = "/zen/go/v1";
// OpenCode 账号的 Go 端点还有 inference 形态（https://opencode.ai/inference/go/openai/v1），
// 上游同样要求 x-opencode-session；按前缀放宽，避免只有 zen 路径才补头。
const OPENCODE_INFERENCE_GO_PREFIX = "/inference/go/";
// billion-context（bili）等本地代理会把上游地址包成 http://127.0.0.1:<port>/bili/<原址>。
// 判定归因头必须按"真实上游"看，否则 hostname 变成回环地址后该头整片丢失。
const PROXY_PATH_PREFIXES = ["/bili/"] as const;

/**
 * 把本地代理包裹过的 baseURL 还原成真实上游 URL；非回环或没有代理前缀时原样返回。
 * 只做字符串识别，不建立网络连接。
 */
export function unwrapProxiedBaseUrl(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const isLoopback =
      hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
    if (!isLoopback) return trimmed;
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // 非法百分号编码保持原样，交给后续匹配决定是否命中。
    }
    for (const prefix of PROXY_PATH_PREFIXES) {
      const index = pathname.indexOf(prefix);
      if (index < 0) continue;
      const inner = pathname.slice(index + prefix.length);
      if (!/^https?:\/\//u.test(inner)) continue;
      return `${inner}${url.search}`;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

export function isOpenCodeGoBaseUrl(baseURL: string | undefined): boolean {
  const unwrapped = unwrapProxiedBaseUrl(baseURL);
  if (!unwrapped) return false;
  try {
    const url = new URL(unwrapped);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return (
      (hostname === OPENCODE_ROOT_DOMAIN || hostname.endsWith(`.${OPENCODE_ROOT_DOMAIN}`)) &&
      (path === OPENCODE_GO_PATH || path.startsWith(OPENCODE_INFERENCE_GO_PREFIX))
    );
  } catch {
    return false;
  }
}
