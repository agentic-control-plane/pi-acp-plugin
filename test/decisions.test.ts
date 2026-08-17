// Decision mapping + fail posture for the pi extension.
// gatewaystack-connect#385: attended (ctx.hasUI) fails open LOUDLY, unattended
// fails closed; policy denies unaffected. Empty-chair: ask with no UI -> deny.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import acp from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

/** Minimal pi-shaped API that captures registered handlers. */
function fakePi() {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    on: (event: string, fn: Handler) => {
      handlers[event] = fn;
    },
  };
}

/** Fake ExtensionContext. hasUI toggles attended vs unattended. confirmValue drives the ask prompt. */
function fakeCtx({ hasUI = true, confirmValue = true, sessionId = "sess-1" } = {}) {
  const notes: Array<{ msg: string; level: string }> = [];
  return {
    notes,
    hasUI,
    mode: hasUI ? "tui" : "print",
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (msg: string, level: string) => notes.push({ msg, level }),
      confirm: async () => confirmValue,
    },
  };
}

/** One-route stub gateway; respond(url, body) decides per request. */
function stubGateway(
  respond: (url: string, body: any) => { status?: number; json?: any },
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const { status = 200, json = {} } = respond(req.url ?? "", JSON.parse(raw || "{}"));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    }),
  );
}

const CALL = {
  type: "tool_call",
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "rm -rf /" },
};

function mount(base: string) {
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = base;
  delete process.env.ACP_AGENT_TIER;
  const pi = fakePi();
  acp(pi as any);
  return pi.handlers;
}

test("policy deny blocks with the reason", async () => {
  const { server, base } = await stubGateway(() => ({ json: { decision: "deny", reason: "blast radius" } }));
  const decision = await mount(base).tool_call(CALL, fakeCtx());
  assert.equal(decision.block, true);
  assert.match(decision.reason, /Denied by policy: blast radius/);
  server.close();
});

test("policy allow returns undefined (call proceeds)", async () => {
  const { server, base } = await stubGateway(() => ({ json: { decision: "allow" } }));
  const decision = await mount(base).tool_call(CALL, fakeCtx());
  assert.equal(decision, undefined);
  server.close();
});

test("ask + attended + operator approves -> proceeds", async () => {
  const { server, base } = await stubGateway(() => ({ json: { decision: "ask", reason: "needs review" } }));
  const decision = await mount(base).tool_call(CALL, fakeCtx({ hasUI: true, confirmValue: true }));
  assert.equal(decision, undefined);
  server.close();
});

test("ask + attended + operator declines -> blocked", async () => {
  const { server, base } = await stubGateway(() => ({ json: { decision: "ask", reason: "needs review" } }));
  const decision = await mount(base).tool_call(CALL, fakeCtx({ hasUI: true, confirmValue: false }));
  assert.equal(decision.block, true);
  assert.match(decision.reason, /Denied at approval prompt/);
  server.close();
});

test("empty chair: ask + unattended (no UI) -> deny, not hang", async () => {
  const { server, base } = await stubGateway(() => ({ json: { decision: "ask", reason: "needs review" } }));
  const decision = await mount(base).tool_call(CALL, fakeCtx({ hasUI: false }));
  assert.equal(decision.block, true);
  assert.match(decision.reason, /no operator is present/);
  server.close();
});

test("gateway unreachable: attended fails OPEN, loudly", async () => {
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = "http://127.0.0.1:1"; // nothing listening
  delete process.env.ACP_AGENT_TIER;
  const pi = fakePi();
  acp(pi as any);
  const ctx = fakeCtx({ hasUI: true });
  const decision = await pi.handlers.tool_call(CALL, ctx);
  assert.equal(decision, undefined, "attended fails open");
  assert.ok(ctx.notes.some((n) => /UNGOVERNED/.test(n.msg)), "warns loudly");
});

test("gateway unreachable: unattended fails CLOSED", async () => {
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = "http://127.0.0.1:1";
  delete process.env.ACP_AGENT_TIER;
  const pi = fakePi();
  acp(pi as any);
  const decision = await pi.handlers.tool_call(CALL, fakeCtx({ hasUI: false }));
  assert.equal(decision.block, true, "unattended fails closed");
  assert.match(decision.reason, /stays blocked when policy can't be consulted/);
});

test("tool_result block becomes an error result the model sees", async () => {
  const { server, base } = await stubGateway((url) =>
    url.includes("tool-output")
      ? { json: { action: "block", reason: "secret in output" } }
      : { json: { decision: "allow" } },
  );
  const result = await mount(base).tool_result(
    { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text: "x" }], isError: false },
    fakeCtx(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Blocked: secret in output/);
  server.close();
});

test("tool_result redact rewrites what the model reads", async () => {
  const { server, base } = await stubGateway((url) =>
    url.includes("tool-output")
      ? { json: { action: "redact", tool_output: "[REDACTED]" } }
      : { json: { decision: "allow" } },
  );
  const result = await mount(base).tool_result(
    { type: "tool_result", toolName: "read", toolCallId: "c1", input: {}, content: [{ type: "text", text: "SECRET=abc" }], isError: false },
    fakeCtx(),
  );
  assert.equal(result.content[0].text, "[REDACTED]");
  server.close();
});

test("tool_result unreachable passes through silently (observability only)", async () => {
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = "http://127.0.0.1:1";
  const pi = fakePi();
  acp(pi as any);
  const result = await pi.handlers.tool_result(
    { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text: "ok" }], isError: false },
    fakeCtx(),
  );
  assert.equal(result, undefined);
});

test("no credential: no tool_call handler is registered (fails open, warns at session_start)", async () => {
  delete process.env.ACP_BEARER_TOKEN;
  delete process.env.ACP_GOVERN_BASE;
  const saved = process.env.HOME;
  process.env.HOME = "/nonexistent-acp-home-for-test";
  const pi = fakePi();
  acp(pi as any);
  process.env.HOME = saved;
  assert.equal(pi.handlers.tool_call, undefined, "no governance handler without a token");
  assert.equal(typeof pi.handlers.session_start, "function", "but it still warns at session start");
});
