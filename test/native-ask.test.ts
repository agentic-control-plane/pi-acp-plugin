// gatewaystack-connect#1518 / #1902: the native ask is bounded and renders the
// gateway's own reason. A prompt nobody answers is a deny, never a hang; a
// gateway-branded reason is shown verbatim (its first line is the title); the
// decline reason tells the model not to retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import acp, { ACP_ASK_PREFIX, DEFAULT_ASK_TIMEOUT_MS, askPrompt, askTimeoutMs } from "../index.ts";

const GATEWAY_REASON = `${ACP_ASK_PREFIX}Force-push main to origin\n  agent says: "rewrite history"\n  git push --force origin main · destructive floor · yes = run once`;

async function stubGateway(reason: string) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "ask", reason }));
    });
  });
  const base: string = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)),
  );
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = base;
  delete process.env.ACP_AGENT_TIER;
  const handlers: Record<string, any> = {};
  acp({ on: (e: string, fn: any) => (handlers[e] = fn) } as any);
  return { handlers, server };
}

function ctxWith(confirm: (title: string, body: string) => Promise<boolean>) {
  return {
    hasUI: true,
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "sess-ask" },
    ui: { notify: () => {}, confirm },
  };
}

const CALL = { type: "tool_call", toolName: "bash", toolCallId: "c-ask", input: { command: "git push --force origin main" } };

test("a prompt nobody answers is denied after the ask timeout, not left hanging (#1902)", async () => {
  process.env.ACP_ASK_TIMEOUT_MS = "50";
  const { handlers, server } = await stubGateway("needs review");
  try {
    const never = () => new Promise<boolean>(() => {});
    const started = Date.now();
    const decision = await handlers.tool_call(CALL, ctxWith(never));
    assert.ok(Date.now() - started < 5_000, "resolved by the timeout, not by the test runner");
    assert.equal(decision.block, true);
    assert.match(decision.reason, /nobody answered the prompt/);
    assert.match(decision.reason, /do not retry the same command/);
  } finally {
    delete process.env.ACP_ASK_TIMEOUT_MS;
    server.close();
  }
});

test("a prompt that throws is a decline, not an allow", async () => {
  const { handlers, server } = await stubGateway("needs review");
  try {
    const decision = await handlers.tool_call(CALL, ctxWith(async () => { throw new Error("ui gone"); }));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /the operator said no/);
  } finally {
    server.close();
  }
});

test("the gateway's branded reason is rendered verbatim: line 1 is the title, the rest the body", async () => {
  const { handlers, server } = await stubGateway(GATEWAY_REASON);
  try {
    let seen: { title: string; body: string } | undefined;
    const decision = await handlers.tool_call(CALL, ctxWith(async (title, body) => { seen = { title, body }; return true; }));
    assert.equal(decision, undefined, "approved → the call proceeds");
    assert.equal(seen?.title, `${ACP_ASK_PREFIX}Force-push main to origin`);
    assert.match(seen?.body ?? "", /agent says: "rewrite history"/);
    assert.match(seen?.body ?? "", /git push --force origin main · destructive floor · yes = run once/);
    assert.match(seen?.body ?? "", /Allow this call\?$/);
    // The command is in the gateway's line 3 already; it is not repeated.
    assert.equal((seen?.body.match(/git push --force origin main/g) ?? []).length, 1);
  } finally {
    server.close();
  }
});

test("an unbranded reason keeps the tool + input in the body", () => {
  const p = askPrompt("needs review", "bash", { command: "ls -la" });
  assert.equal(p.title, "[ACP] Approval required");
  assert.match(p.body, /needs review/);
  assert.match(p.body, /bash: ls -la/);
});

test("ask timeout defaults to the gateway's 600s TTL; garbage or zero falls back", () => {
  for (const v of [undefined, "", "0", "-5", "NaN", "soon"]) {
    if (v === undefined) delete process.env.ACP_ASK_TIMEOUT_MS;
    else process.env.ACP_ASK_TIMEOUT_MS = v;
    assert.equal(askTimeoutMs(), DEFAULT_ASK_TIMEOUT_MS, String(v));
  }
  process.env.ACP_ASK_TIMEOUT_MS = "1500";
  assert.equal(askTimeoutMs(), 1500);
  delete process.env.ACP_ASK_TIMEOUT_MS;
});
