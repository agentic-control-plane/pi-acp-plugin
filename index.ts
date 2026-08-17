/**
 * Agentic Control Plane for pi (earendil-works/pi).
 *
 * A native pi extension on the harness's typed interception events:
 *
 *   tool_call   -> POST {ACP_GOVERN}/govern/tool-use    (allow / ask / deny)
 *   tool_result -> POST {ACP_GOVERN}/govern/tool-output (audit / DLP / shadow notices)
 *
 * pi ships four tools and no permission system by design; this extension is
 * the whole coverage story — pi has no MCP layer to supplement. Every tool
 * dispatch (bash, read, write, edit, and any custom or extension-registered
 * tool) flows through `tool_call` before it runs and `tool_result` after.
 *
 * Decision mapping onto pi's ToolCallEventResult:
 *   allow -> return undefined (the call proceeds)
 *   deny  -> { block: true, reason }
 *   ask   -> attended (ctx.hasUI): prompt via ctx.ui.confirm; approve -> proceed,
 *            decline -> block. Unattended (!ctx.hasUI, i.e. print/json mode):
 *            block — an agent with nobody watching cannot self-approve. That is
 *            the empty-chair posture, and pi's ctx.hasUI states it exactly.
 *
 * Unreachability posture (gatewaystack-connect#385, never-brick): attended
 * sessions fail OPEN with a loud UNGOVERNED warning and a ~/.acp/lapse.log
 * entry; unattended runs fail CLOSED — nobody is watching, so the block is the
 * safety net. Policy denies are unaffected; this posture only covers the
 * inability to ASK the policy (gatewaystack-connect#690: one transport retry
 * before the fail posture, because the slow answers are cold starts).
 *
 * Dependency-free: the only import is a type (erased at runtime), so this file
 * runs as-is when dropped at ~/.pi/agent/extensions/acp.ts.
 *
 * @module @agenticcontrolplane/pi
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_VERSION = "0.1.0";

/** 200 KB ceiling on tool output sent for post-hoc scanning (matches the backend). */
const POST_HOOK_PAYLOAD_CEILING = 200 * 1024;

/** Hook decision budget: control-plane calls answer fast or get out of the way. */
const CHECK_TIMEOUT_MS = 4000;

const CONSOLE_BASE = "https://cloud.agenticcontrolplane.com";

interface Decision {
  decision?: "allow" | "ask" | "deny";
  reason?: string;
  warning?: string;
}

interface OutputVerdict {
  action?: "pass" | "block" | "redact";
  reason?: string;
  tool_output?: string;
  notice?: string;
}

interface SessionStats {
  calls: number;
  denied: number;
  asked: number;
  notices: number;
}

/**
 * Session-receipt contract (gatewaystack-connect#606, same one line as the
 * Claude Code and dsh plugins): at session end, say how many calls ACP
 * governed, anything it said, and deep-link this session. Returns null when
 * there is nothing to say — zero governed calls must produce zero spam.
 */
export function buildReceiptMessage(
  stats: SessionStats | undefined,
  sessionId: string,
  consoleBase = CONSOLE_BASE,
): string | null {
  if (!stats || !(stats.calls > 0)) return null;
  const parts = [`${stats.calls} tool call${stats.calls === 1 ? "" : "s"} governed`];
  if (stats.denied > 0) parts.push(`${stats.denied} denied`);
  if (stats.asked > 0) parts.push(`${stats.asked} held for approval`);
  if (stats.notices > 0) parts.push(`${stats.notices} shadow notice${stats.notices === 1 ? "" : "s"}`);
  const url = `${consoleBase}/sessions/${encodeURIComponent(sessionId)}`;
  return `[ACP] Session receipt: ${parts.join(" · ")} — review this session: ${url}`;
}

function readToken(): string | null {
  if (process.env.ACP_BEARER_TOKEN) return process.env.ACP_BEARER_TOKEN;
  // Same order as the other harness plugins' credential lookup — keep in sync.
  for (const file of ["credentials", "proxy-key"]) {
    try {
      const value = readFileSync(join(homedir(), ".acp", file), "utf8").trim();
      if (value) return value;
    } catch {
      /* absent or unreadable — try the next path */
    }
  }
  return null;
}

function lapseLine(fields: Record<string, unknown>): void {
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    appendFileSync(
      join(homedir(), ".acp", "lapse.log"),
      `${JSON.stringify({ at: new Date().toISOString(), client: "pi-plugin", ...fields })}\n`,
    );
  } catch {
    /* the lapse log is best-effort — never block a call on it */
  }
}

/** Say something to the operator: the TUI/RPC notification if we have UI, stderr otherwise. */
function tell(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
      return;
    }
  } catch {
    /* fall through to stderr */
  }
  // Print/JSON mode: stderr keeps the message off the model-visible stdout stream.
  console.error(message);
}

const shadowOff = () => /^(off|0|false)$/i.test(process.env.ACP_SHADOW ?? "");

export default function acp(pi: ExtensionAPI): void {
  const govern = (
    process.env.ACP_GOVERN_BASE ??
    process.env.ACP_API_BASE ??
    "https://govern.agenticcontrolplane.com"
  ).replace(/\/$/, "");
  const token = readToken();

  if (!token) {
    // Loud, once at load, plus a durable lapse line per session start — an
    // uncredentialed control plane must never be mistaken for a live one.
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (!warned) {
        tell(
          ctx,
          "[ACP] ⚠ UNGOVERNED: no credential (ACP_BEARER_TOKEN or ~/.acp/credentials) — " +
            "tool calls run WITHOUT policy checks and ACP has no record of them. " +
            "Connect at https://cloud.agenticcontrolplane.com",
          "warning",
        );
        warned = true;
      }
      try {
        lapseLine({ kind: "UNGOVERNED", reason: "no-credentials", session: ctx.sessionManager.getSessionId() });
      } catch {
        /* best-effort */
      }
    });
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GS-Client": `pi-plugin/${PLUGIN_VERSION}`,
  };

  // --- Session receipt bookkeeping. In-memory per session id; a stats failure
  // must never affect a call, so every touch is wrapped. ---
  const sessionStats = new Map<string, SessionStats>();
  const statsFor = (sid: string | undefined): SessionStats | null => {
    if (!sid) return null;
    let s = sessionStats.get(sid);
    if (!s) {
      s = { calls: 0, denied: 0, asked: 0, notices: 0 };
      sessionStats.set(sid, s);
    }
    return s;
  };
  const sidOf = (ctx: ExtensionContext): string | undefined => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  };
  const bump = (ctx: ExtensionContext, field: keyof SessionStats): void => {
    try {
      const s = statsFor(sidOf(ctx));
      if (s) s[field] += 1;
    } catch {
      /* bookkeeping only */
    }
  };

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      const sid = sidOf(ctx);
      if (!sid) return;
      const s = sessionStats.get(sid);
      sessionStats.delete(sid);
      const line = buildReceiptMessage(s, sid);
      if (line) tell(ctx, line, "info");
    } catch {
      /* the receipt is best-effort — never let it touch teardown */
    }
  });

  // pi's attended/unattended signal is ctx.hasUI directly (false in print/json
  // mode). ACP_AGENT_TIER overrides for callers who know better.
  const tierOf = (ctx: ExtensionContext): string =>
    process.env.ACP_AGENT_TIER ?? (ctx.hasUI ? "interactive" : "background");

  async function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const res = await fetch(`${govern}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Tagged so the pre-call retry can tell "the server answered with a
        // status" from "the request never landed". Re-rolling a 429 would
        // deepen the rate limit it is reporting.
        const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`) as Error & {
          httpStatus?: number;
        };
        err.httpStatus = res.status;
        throw err;
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function checkPayload(
    ctx: ExtensionContext,
    toolName: string,
    input: unknown,
    toolCallId: string,
    event: string,
  ): Record<string, unknown> {
    return {
      tool_name: toolName,
      tool_input: input,
      session_id: sidOf(ctx),
      call_id: toolCallId,
      cwd: ctx.cwd,
      hook_event_name: event,
      agent_tier: tierOf(ctx),
    };
  }

  // --- Pre-call policy check: the decision happens before the tool runs. ---
  pi.on("tool_call", async (event, ctx) => {
    const payload = () => checkPayload(ctx, event.toolName, event.input, event.toolCallId, "PreToolUse");
    let data: Decision;
    try {
      try {
        data = await post<Decision>("/govern/tool-use", payload(), ctx.signal);
      } catch (first) {
        // Retry once before applying the fail posture (gatewaystack-connect#690):
        // a confirmed incident had the gateway answer HTTP 200 (an allow) just
        // after the client aborted at 4s, and the unattended tier turned that
        // into a deny. Cold starts are the cause, so the retry lands warm.
        // Retry only a transport failure: an HTTP status is the server
        // answering, and a caller-cancelled call is already gone.
        const e = first as (Error & { httpStatus?: number }) | undefined;
        if (e?.httpStatus !== undefined || ctx.signal?.aborted) throw first;
        data = await post<Decision>("/govern/tool-use", payload(), ctx.signal);
      }
    } catch (error) {
      const err = error as Error | undefined;
      const detail = err?.name === "AbortError" ? "request timed out" : (err?.message ?? "network error");
      if (ctx.hasUI) {
        // Attended: lapse loudly and leave the audit trail ACP never saw.
        lapseLine({ kind: "UNGOVERNED", tool: event.toolName, tier: tierOf(ctx), detail });
        tell(
          ctx,
          `[ACP] ⚠ UNGOVERNED: gateway unreachable (${detail}) — ${event.toolName} proceeded WITHOUT policy check. Lapse logged to ~/.acp/lapse.log.`,
          "warning",
        );
        return undefined;
      }
      // Unattended: hold the line, say why honestly.
      return {
        block: true,
        reason: `[ACP] Gateway unreachable (${detail}) — ${tierOf(ctx)} tier stays blocked when policy can't be consulted (fail-closed for unattended agents; interactive sessions fail open).`,
      };
    }

    bump(ctx, "calls");

    if (data.decision === "deny") {
      bump(ctx, "denied");
      return { block: true, reason: `[ACP] Denied by policy: ${data.reason ?? "policy did not return a reason"}` };
    }

    if (data.decision === "ask") {
      bump(ctx, "asked");
      const reason = data.reason ?? "approval required";
      if (!ctx.hasUI) {
        // Empty chair: nobody can answer, so the ask is a deny. pi states the
        // condition exactly via ctx.hasUI — no timeout guesswork.
        return {
          block: true,
          reason: `[ACP] Approval required but no operator is present (${reason}) — denied. An unattended agent cannot self-approve; review it at ${CONSOLE_BASE}.`,
        };
      }
      let approved = false;
      try {
        approved = await ctx.ui.confirm(
          "[ACP] Approval required",
          `${reason}\n\n${event.toolName}: ${summarizeInput(event.input)}\n\nAllow this call?`,
        );
      } catch {
        // If the prompt itself fails, treat it as no-answer → deny.
        approved = false;
      }
      if (!approved) {
        return { block: true, reason: `[ACP] Denied at approval prompt: ${reason}` };
      }
      return undefined;
    }

    if (data.warning) tell(ctx, String(data.warning), "warning");
    return undefined;
  });

  // --- Post-call audit: the result is reported for scanning; a server block
  // becomes corrective feedback, a redact rewrites what the model reads. ---
  pi.on("tool_result", async (event, ctx) => {
    let outputStr = "";
    try {
      outputStr = event.content
        .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
        .join("\n");
    } catch {
      return undefined;
    }
    if (Buffer.byteLength(outputStr, "utf8") > POST_HOOK_PAYLOAD_CEILING) {
      outputStr = outputStr.slice(0, POST_HOOK_PAYLOAD_CEILING);
    }

    let data: OutputVerdict;
    try {
      data = await post<OutputVerdict>(
        "/govern/tool-output",
        {
          ...checkPayload(ctx, event.toolName, event.input, event.toolCallId, "PostToolUse"),
          tool_output: outputStr,
        },
        ctx.signal,
      );
    } catch {
      // Post-hoc scanning is observability: silent pass-through, the call
      // already ran. The pre-call check is where unreachability gets loud.
      return undefined;
    }

    if (data.action === "block") {
      return {
        content: [{ type: "text" as const, text: `[ACP] Blocked: ${data.reason ?? "policy"}` }],
        isError: true,
      };
    }
    if (data.action === "redact" && typeof data.tool_output === "string") {
      // DLP / ad-block rewrite: the model sees the transformed output.
      return { content: [{ type: "text" as const, text: data.tool_output }] };
    }
    if (typeof data.notice === "string" && data.notice.trim() && !shadowOff()) {
      // Shadow-mode counterfactual (#607): advisory, arrives with action "pass".
      bump(ctx, "notices");
      tell(ctx, data.notice, "info");
    }
    return undefined;
  });
}

/** Compact one-line view of tool input for the approval prompt. */
function summarizeInput(input: unknown): string {
  try {
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (typeof obj.command === "string") return obj.command;
      if (typeof obj.path === "string") return obj.path;
    }
    const s = JSON.stringify(input);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return "(uninspectable input)";
  }
}
