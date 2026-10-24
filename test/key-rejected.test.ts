// A 401/403 from the gateway is a credential failure, not an outage, and a 401
// with `code: "workspace_deleted"` says so once per session
// (gatewaystack-connect#1693; mirrors claude-code-acp-plugin
// test/workspace-deleted-notice.test.mjs + test/429-is-a-verdict.test.mjs).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acp, { firstDeletedNotice } from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function fakeCtx({ hasUI = true, sessionId = "sess-1" as string | undefined } = {}) {
  const notes: Array<{ msg: string; level: string }> = [];
  return {
    notes,
    hasUI,
    mode: hasUI ? "tui" : "print",
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }), confirm: async () => true },
  };
}

function stubGateway(status: number, json: unknown): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
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

const CALL = { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command: "echo hi" } };
const DELETED = { error: "workspace deleted", code: "workspace_deleted" };

let home = "";
let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "acp-pi-keyrej-"));
  process.env.HOME = home; // never touch the real ~/.acp
});
afterEach(() => {
  process.env.HOME = savedHome;
});

function mount(base: string) {
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = base;
  delete process.env.ACP_AGENT_TIER;
  const handlers: Record<string, Handler> = {};
  acp({ on: (e: string, fn: Handler) => { handlers[e] = fn; } } as any);
  return handlers;
}

test("attended 401 proceeds with KEY REJECTED naming the key and fix; lapse logged", async () => {
  const { server, base } = await stubGateway(401, { error: "invalid key" });
  const ctx = fakeCtx();
  const decision = await mount(base).tool_call(CALL, ctx);
  server.close();
  assert.equal(decision, undefined);
  const msg = ctx.notes.map((n) => n.msg).join("\n");
  assert.match(msg, /^\[ACP\] ⚠ KEY REJECTED \(HTTP 401\): the key in ~\/\.acp\/credentials is revoked or invalid/);
  assert.match(msg, /install\.sh/);
  assert.match(msg, /settings\/api-keys/);
  assert.doesNotMatch(msg, /unreachable/i);
  assert.match(readFileSync(join(home, ".acp", "lapse.log"), "utf8"), /key rejected \(HTTP 401\)/);
});

test("unattended 401 stays blocked with the cause named", async () => {
  const { server, base } = await stubGateway(401, undefined);
  const decision = await mount(base).tool_call(CALL, fakeCtx({ hasUI: false }));
  server.close();
  assert.equal(decision.block, true);
  assert.match(decision.reason, /Key rejected \(HTTP 401\)/);
  assert.match(decision.reason, /~\/\.acp\/credentials/);
  assert.doesNotMatch(decision.reason, /unreachable/i);
});

test("403 is treated like 401", async () => {
  const { server, base } = await stubGateway(403, { error: "forbidden" });
  const h = mount(base);
  const ctx = fakeCtx();
  assert.equal(await h.tool_call(CALL, ctx), undefined);
  assert.match(ctx.notes[0].msg, /KEY REJECTED \(HTTP 403\)/);
  const blocked = await h.tool_call(CALL, fakeCtx({ hasUI: false }));
  server.close();
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Key rejected \(HTTP 403\)/);
});

test("5xx keeps the outage posture", async () => {
  const { server, base } = await stubGateway(503, { error: "down" });
  const h = mount(base);
  const ctx = fakeCtx();
  assert.equal(await h.tool_call(CALL, ctx), undefined);
  assert.match(ctx.notes[0].msg, /UNGOVERNED: gateway unreachable \(HTTP 503/);
  const blocked = await h.tool_call(CALL, fakeCtx({ hasUI: false }));
  server.close();
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Gateway unreachable/);
});

test("attended workspace_deleted: one notice per session, then silent; lapse logged every call", async () => {
  const { server, base } = await stubGateway(401, DELETED);
  const h = mount(base);
  const a1 = fakeCtx({ sessionId: "sess-a" });
  assert.equal(await h.tool_call(CALL, a1), undefined);
  assert.match(a1.notes[0].msg, /workspace this machine was connected to has been deleted/);
  assert.match(a1.notes[0].msg, /acp-uninstall/);
  assert.match(a1.notes[0].msg, /uninstall\.sh/);
  assert.ok(existsSync(join(home, ".acp", "notices", "workspace-deleted.sess-a")));
  const a2 = fakeCtx({ sessionId: "sess-a" });
  assert.equal(await h.tool_call(CALL, a2), undefined);
  assert.equal(a2.notes.length, 0, "silent after the first notice");
  const b = fakeCtx({ sessionId: "sess-b" });
  await h.tool_call(CALL, b);
  server.close();
  assert.match(b.notes[0].msg, /has been deleted/);
  assert.equal(readFileSync(join(home, ".acp", "lapse.log"), "utf8").trim().split("\n").length, 3);
});

test("unattended workspace_deleted denies every call with the deleted message", async () => {
  const { server, base } = await stubGateway(401, DELETED);
  const h = mount(base);
  for (let i = 0; i < 2; i++) {
    const d = await h.tool_call(CALL, fakeCtx({ hasUI: false, sessionId: "sess-u" }));
    assert.equal(d.block, true);
    assert.match(d.reason, /has been deleted/);
    assert.match(d.reason, /acp-uninstall/);
  }
  server.close();
});

test("no session id: notice at most once per 24h", () => {
  const t0 = Date.parse("2026-10-24T00:00:00Z");
  assert.equal(firstDeletedNotice(undefined, t0), true);
  assert.equal(firstDeletedNotice(undefined, t0 + 60_000), false);
  assert.equal(firstDeletedNotice(undefined, t0 + 25 * 60 * 60 * 1000), true);
});
