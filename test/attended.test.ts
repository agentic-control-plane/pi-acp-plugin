import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import acp from "../index.ts";

function ctxOf(hasUI: boolean) {
  return {
    hasUI,
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "sess-att" },
    ui: { notify: () => {}, confirm: async () => true },
  };
}

/** Mount against a stub gateway; returns handlers + every body the gateway saw. */
async function setup(tier?: string) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    });
  });
  const base: string = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)),
  );
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = base;
  if (tier === undefined) delete process.env.ACP_AGENT_TIER;
  else process.env.ACP_AGENT_TIER = tier;
  const handlers: Record<string, any> = {};
  acp({ on: (e: string, fn: any) => (handlers[e] = fn) } as any);
  return { handlers, bodies, server };
}

const CALL = { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "ls" } };
const RESULT = { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text: "ok" }], isError: false };

test("PreToolUse: hasUI true -> attended claim true, source hasUI, native_ask", async () => {
  const { handlers, bodies, server } = await setup();
  await handlers.tool_call(CALL, ctxOf(true));
  assert.deepEqual(bodies[0].attended, { claim: true, source: "hasUI" });
  assert.deepEqual(bodies[0].capabilities, ["native_ask"]);
  server.close();
});

test("PreToolUse: hasUI false -> attended claim false (positive no-dialog)", async () => {
  const { handlers, bodies, server } = await setup();
  await handlers.tool_call(CALL, ctxOf(false));
  assert.deepEqual(bodies[0].attended, { claim: false, source: "hasUI" });
  server.close();
});

test("claim comes from ctx.hasUI, never from ACP_AGENT_TIER", async () => {
  let t = await setup("interactive");
  await t.handlers.tool_call(CALL, ctxOf(false));
  assert.equal(t.bodies[0].agent_tier, "interactive"); // tier behaviour unchanged
  assert.equal(t.bodies[0].attended.claim, false);
  t.server.close();
  t = await setup("background");
  await t.handlers.tool_call(CALL, ctxOf(true));
  assert.equal(t.bodies[0].agent_tier, "background");
  assert.equal(t.bodies[0].attended.claim, true);
  t.server.close();
});

test("PostToolUse carries no attended and no capabilities", async () => {
  const { handlers, bodies, server } = await setup();
  await handlers.tool_result(RESULT, ctxOf(true));
  assert.equal(bodies[0].hook_event_name, "PostToolUse");
  assert.equal("attended" in bodies[0], false);
  assert.equal("capabilities" in bodies[0], false);
  server.close();
});
