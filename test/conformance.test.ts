// ACP plugin conformance adapter for pi-acp-plugin (gatewaystack-connect#1344,
// step 1). Drives the REAL plugin entry point (imported from ../index.ts, not
// reimplemented) against a fake gateway, using the shared corpus vendored at
// test/fixtures/plugin-corpus.json. See that corpus's own "purpose" field for
// the seam this closes: unit tests stayed green while four plugins dropped
// every gateway notice (#1334).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acp from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

// --- Corpus loading + fingerprint pin -------------------------------------

const CORPUS_PATH = join(import.meta.dirname, "fixtures", "plugin-corpus.json");
const PINNED_FINGERPRINT = "aa186d3fb3e7d18c";
const PLUGIN_NAME = "pi-acp-plugin";
const MARKER = "ACPCONF7F3A";

const rawCorpus = readFileSync(CORPUS_PATH);
const actualFingerprint = createHash("sha256").update(rawCorpus).digest("hex").slice(0, 16);

test("vendored corpus matches the pinned fingerprint", () => {
  assert.equal(
    actualFingerprint,
    PINNED_FINGERPRINT,
    "test/fixtures/plugin-corpus.json has drifted from the canonical copy at " +
      "gatewaystack-connect:conformance/plugin-corpus.json — re-copy it with `cp` " +
      "(never retype) and update PINNED_FINGERPRINT in the same change.",
  );
});

const corpus = JSON.parse(rawCorpus.toString("utf8"));
assert.equal(corpus.marker, MARKER, "corpus marker constant drifted from this adapter's copy");

const rows = corpus.harnesses.filter((h: any) => h.plugin === PLUGIN_NAME);
test("corpus declares both capabilities supported for pi-acp-plugin", () => {
  assert.deepEqual(
    rows.map((r: any) => [r.capability, r.status]).sort(),
    [
      ["notice", "supported"],
      ["post-tool", "supported"],
    ],
  );
});

function caseFor(id: string) {
  const c = corpus.cases.find((c: any) => c.id === id);
  assert.ok(c, `corpus is missing case ${id}`);
  return c;
}

/**
 * Canonical tool-name mapping (documented, per the corpus's "post-tool"
 * adapterMust): the corpus's generic call.tool "shell" maps onto pi's own
 * native tool name for its bash tool, "bash" — pi ships four built-in tools
 * (bash, read, write, edit; see index.ts's module doc and README.md) and the
 * shell/echo case in the corpus is pi's "bash" tool.
 */
const NATIVE_TOOL_NAME_FOR_SHELL = "bash";

/**
 * Known, currently-observed failures against origin/main. Each entry must be
 * accompanied by a case that is asserted to FAIL (see runCase below) — a
 * fix removes the entry, a new regression here fails CI until it's added
 * back with evidence, and this array is checked to be exactly this by the
 * test at the bottom of the file.
 */
const EXPECTED_DIVERGENCES: Array<{ id: string; issue: string; evidence: string }> = [];

const observedDivergences: string[] = [];

/** Runs `fn`; if `id` is a declared divergence, asserts `fn` throws/rejects instead of passing. */
async function runCase(id: string, fn: () => Promise<void> | void): Promise<void> {
  const declared = EXPECTED_DIVERGENCES.find((d) => d.id === id);
  if (!declared) {
    await fn();
    return;
  }
  observedDivergences.push(id);
  await assert.rejects(
    async () => {
      await fn();
    },
    undefined,
    `case ${id} is listed in EXPECTED_DIVERGENCES (${declared.issue}) but its assertions passed — remove the entry, it's fixed`,
  );
}

// --- Fake pi host ----------------------------------------------------------

function fakePi() {
  const handlers: Record<string, Handler> = {};
  return { handlers, on: (event: string, fn: Handler) => { handlers[event] = fn; } };
}

function fakeCtx(opts: { hasUI: boolean; sessionId?: string }) {
  const notes: Array<{ msg: string; level: string }> = [];
  return {
    notes,
    hasUI: opts.hasUI,
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => opts.sessionId ?? "acpconf-session-0001" },
    ui: {
      notify: (msg: string, level: string) => notes.push({ msg, level }),
      confirm: async () => true,
    },
  };
}

/** Fake gateway: /govern/tool-output answers with `gatewayReply`; every other path allows. Records every request. */
function stubGateway(gatewayReply: unknown): Promise<{
  server: Server;
  base: string;
  requests: Array<{ method: string; path: string; body: any }>;
}> {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = req.url ?? "";
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method ?? "", path, body });
      const json = path === "/govern/tool-output" ? gatewayReply : { decision: "allow" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, requests });
    });
  });
}

/**
 * Mounts the real plugin: fresh HOME (per adapterMust, so no developer-machine
 * state — e.g. a warned-once flag or lapse.log — can suppress a notice),
 * dummy credential, base pointed at the fake gateway, case.env applied, and
 * ACP_SHADOW cleared unless the case sets it.
 */
function mount(base: string, caseEnv: Record<string, string> = {}): Record<string, Handler> {
  const homeDir = mkdtempSync(join(tmpdir(), "acpconf-pi-home-"));
  process.env.ACP_BEARER_TOKEN = "acpconf-dummy-credential-not-real";
  process.env.ACP_GOVERN_BASE = base;
  process.env.HOME = homeDir;
  delete process.env.ACP_API_BASE;
  delete process.env.ACP_AGENT_TIER;
  delete process.env.ACP_SHADOW;
  for (const [k, v] of Object.entries(caseEnv)) process.env[k] = v;
  const pi = fakePi();
  acp(pi as any);
  return pi.handlers;
}

const toolResultEvent = (overrides: Partial<any> = {}) => ({
  type: "tool_result",
  toolName: "bash",
  toolCallId: "acpconf-call-1",
  input: {},
  content: [{ type: "text", text: "irrelevant for the notice cases" }],
  isError: false,
  ...overrides,
});

// --- notice-shown: attended channel (ctx.ui.notify) -------------------------

test("notice-shown: gateway notice reaches the operator via ctx.ui.notify (attended)", async () => {
  await runCase("notice-shown", async () => {
    const c = caseFor("notice-shown");
    const { server, base } = await stubGateway(c.gatewayReply);
    try {
      const handlers = mount(base, c.env);
      const ctx = fakeCtx({ hasUI: true });
      await handlers.tool_result(toolResultEvent(), ctx);
      const seen = ctx.notes.some((n) => n.msg.includes(MARKER));
      assert.equal(seen, c.expect.personSees, `ctx.ui.notify notes: ${JSON.stringify(ctx.notes)}`);
    } finally {
      server.close();
    }
  });
});

// --- notice-shown: unattended channel (stderr via console.error) -----------

test("notice-shown: gateway notice reaches the operator via stderr (unattended, no UI)", async () => {
  await runCase("notice-shown", async () => {
    const c = caseFor("notice-shown");
    const { server, base } = await stubGateway(c.gatewayReply);
    const originalError = console.error;
    const stderrLines: string[] = [];
    console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(" ")); };
    try {
      const handlers = mount(base, c.env);
      const ctx = fakeCtx({ hasUI: false });
      await handlers.tool_result(toolResultEvent(), ctx);
      const seen = stderrLines.some((l) => l.includes(MARKER));
      assert.equal(seen, c.expect.personSees, `stderr lines: ${JSON.stringify(stderrLines)}`);
    } finally {
      console.error = originalError;
      server.close();
    }
  });
});

// --- notice-shadow-off: both channels, marker must be ABSENT everywhere ----

test("notice-shadow-off: ACP_SHADOW=off silences ctx.ui.notify (attended)", async () => {
  await runCase("notice-shadow-off", async () => {
    const c = caseFor("notice-shadow-off");
    const { server, base } = await stubGateway(c.gatewayReply);
    try {
      const handlers = mount(base, c.env);
      const ctx = fakeCtx({ hasUI: true });
      await handlers.tool_result(toolResultEvent(), ctx);
      const seen = ctx.notes.some((n) => n.msg.includes(MARKER));
      assert.equal(seen, c.expect.personSees, `ctx.ui.notify notes: ${JSON.stringify(ctx.notes)}`);
    } finally {
      server.close();
    }
  });
});

test("notice-shadow-off: ACP_SHADOW=off silences stderr (unattended, no UI)", async () => {
  await runCase("notice-shadow-off", async () => {
    const c = caseFor("notice-shadow-off");
    const { server, base } = await stubGateway(c.gatewayReply);
    const originalError = console.error;
    const stderrLines: string[] = [];
    console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(" ")); };
    try {
      const handlers = mount(base, c.env);
      const ctx = fakeCtx({ hasUI: false });
      await handlers.tool_result(toolResultEvent(), ctx);
      const seen = stderrLines.some((l) => l.includes(MARKER));
      assert.equal(seen, c.expect.personSees, `stderr lines: ${JSON.stringify(stderrLines)}`);
    } finally {
      console.error = originalError;
      server.close();
    }
  });
});

// --- post-tool-fields --------------------------------------------------

test("post-tool-fields: POST /govern/tool-output carries the required native fields", async () => {
  await runCase("post-tool-fields", async () => {
    const c = caseFor("post-tool-fields");
    const { server, base, requests } = await stubGateway(c.gatewayReply);
    try {
      const handlers = mount(base, c.env);
      // pi's own native tool_result shape for a shell/bash call: toolName is
      // pi's own name for the tool, input/content are pi's own field names.
      const event = toolResultEvent({
        toolName: NATIVE_TOOL_NAME_FOR_SHELL,
        toolCallId: "acpconf-call-post-tool",
        input: { command: c.call.command },
        content: [{ type: "text", text: c.call.output }],
      });
      const ctx = fakeCtx({ hasUI: true, sessionId: c.call.sessionId });
      await handlers.tool_result(event, ctx);

      const req = requests.find((r) => r.path === "/govern/tool-output");
      assert.ok(req, `no request recorded to /govern/tool-output; saw: ${JSON.stringify(requests.map((r) => r.path))}`);
      assert.equal(req!.method, "POST");
      assert.equal(req!.body.hook_event_name, "PostToolUse");
      assert.equal(
        req!.body.tool_name,
        NATIVE_TOOL_NAME_FOR_SHELL,
        "tool_name must equal the native tool name fed in, or the adapter's declared canonical mapping " +
          `(NATIVE_TOOL_NAME_FOR_SHELL = ${JSON.stringify(NATIVE_TOOL_NAME_FOR_SHELL)})`,
      );
      assert.ok(JSON.stringify(req!.body.tool_input).includes(MARKER), `tool_input missing marker: ${JSON.stringify(req!.body.tool_input)}`);
      assert.ok(JSON.stringify(req!.body.tool_output).includes(MARKER), `tool_output missing marker: ${JSON.stringify(req!.body.tool_output)}`);
      assert.equal(typeof req!.body.session_id, "string");
      assert.ok(req!.body.session_id.length > 0, "session_id must be a non-empty string");
      assert.equal(req!.body.session_id, c.call.sessionId);
    } finally {
      server.close();
    }
  });
});

// --- EXPECTED_DIVERGENCES bookkeeping ---------------------------------------

test("EXPECTED_DIVERGENCES is exactly what this run observed", () => {
  assert.deepEqual(
    observedDivergences.sort(),
    EXPECTED_DIVERGENCES.map((d) => d.id).sort(),
  );
});
