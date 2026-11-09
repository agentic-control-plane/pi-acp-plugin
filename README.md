# @agenticcontrolplane/pi

[![tests](https://github.com/agentic-control-plane/pi-acp-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/agentic-control-plane/pi-acp-plugin/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Agentic Control Plane](https://agenticcontrolplane.com) for [pi](https://github.com/earendil-works/pi): every tool call is checked against your policies before it runs, and every decision is recorded: what ran, what was blocked, and why.

pi ships four tools and [no permission system by design](https://agenticcontrolplane.com/controls/pi). pi has no MCP layer, so one extension on pi's typed events sees everything the agent does:

```
┌─ bash / read / write / edit / custom tools ─┐
│                                             │
│   tool_call  ──►  allow · ask · deny        │   your policy, before the call runs
│   tool_result ─►  audit · redact · block    │   DLP + the record, after
└─────────────────────────────────────────────┘
```

## Install

```sh
curl -sf https://agenticcontrolplane.com/install.sh | bash
```

That detects pi, drops this extension at `~/.pi/agent/extensions/acp.ts`, opens your browser once to sign in, and saves the key to `~/.acp/credentials`, which the extension reads on its own. There is no token to copy and nothing to export.

<details>
<summary>Manual install</summary>

Drop `index.ts` into your global extensions directory as `acp.ts`:

```sh
mkdir -p ~/.pi/agent/extensions
curl -sf https://raw.githubusercontent.com/agentic-control-plane/pi-acp-plugin/main/index.ts \
  -o ~/.pi/agent/extensions/acp.ts
```

Get a key at [cloud.agenticcontrolplane.com](https://cloud.agenticcontrolplane.com) and save it to `~/.acp/credentials`, or set `ACP_BEARER_TOKEN`. Restart pi.

To confirm it loaded, look for the first governed call in your [activity log](https://cloud.agenticcontrolplane.com/logs). Every session also ends with a one-line `[ACP] Session receipt`.

</details>

The extension imports only a **type** from pi (erased at runtime) and Node built-ins, so it has zero dependencies and no build step. It runs as-is the moment pi discovers it.

## How it works

pi dispatches every tool through two typed events, and this extension registers on both:

| pi event | ACP endpoint | What happens |
|---|---|---|
| `tool_call` | `POST /govern/tool-use` | Server returns `allow` / `ask` / `deny`. Deny blocks the call with the reason in the transcript. An ask follows the approval rules below. |
| `tool_result` | `POST /govern/tool-output` | Output scanning. A server block turns the result into corrective feedback; a redact replaces the content the model reads. |

The extension sees every tool call pi dispatches, because pi routes `bash`, `read`, `write`, `edit`, and any custom or extension-registered tool through the same two events. Details on the [pi controls reference](https://agenticcontrolplane.com/controls/pi).

## Approvals when nobody is watching

pi tells the extension whether a human is present through `ctx.hasUI` (true in the TUI, false in `-p`/print and JSON modes). ACP uses it directly:

- **Attended** (`ctx.hasUI`): the extension can show an `ask` as pi's own confirm dialog. Approve and the call proceeds; decline and it's blocked. Today the gateway sends a hold as a prompt only to Claude Code, so in pi a hold is usually a block: approve it on the console or from the email, then retry (see the [coverage matrix](https://agenticcontrolplane.com/coverage)).
- **Unattended** (print/json mode): an `ask` becomes a **deny**. An agent with nobody watching cannot self-approve, and the request is surfaced in the console for later review. No timeouts, no hangs, no silent auto-yes.

## Failure posture

If the gateway can't be reached:

- **Attended sessions fail open, loudly.** The call proceeds, a `[ACP] ⚠ UNGOVERNED` warning is shown, and a line lands in `~/.acp/lapse.log`.
- **Unattended runs fail closed.** With nobody watching, the block is the safety net.
- Policy denies are unaffected. This posture only covers the case where the policy can't be asked. One transport retry precedes the fail posture, because the slow answers are cold starts.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `ACP_BEARER_TOKEN` | `~/.acp/credentials` | Workspace key. |
| `ACP_GOVERN_BASE` | `https://govern.agenticcontrolplane.com` | Gateway, or your self-hosted one. |
| `ACP_AGENT_TIER` | `ctx.hasUI ? interactive : background` | Override the attended/unattended tier. |
| `ACP_SHADOW` | on | `off` silences shadow-mode counterfactual notices. |

No key? The extension says so loudly at session start and stays out of the way, so it never blocks a session.

## Add the cost X-ray

pi has no MCP, and its model calls can route through the ACP proxy for metering. Add a provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "acp": {
      "baseUrl": "https://api.agenticcontrolplane.com/v1",
      "api": "openai-completions",
      "apiKey": "!cat ~/.acp/credentials",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "gemini-3.5-flash" }]
    }
  }
}
```

Then `pi --model acp/gemini-3.5-flash`. The proxy is multi-provider (routes `gpt-*`, `claude-*`, `gemini-*` by model id) and forwards unchanged. You get the same responses, now metered, joined to the tool-audit rows for the same session.

## Requirements and load order

- pi needs **Node 22+**. Node 20 fails to boot pi with an unclear error; use `fnm` or `nvm` to get 22.
- Extensions in the **global** directory (`~/.pi/agent/extensions/`) load without a trust prompt; project-local `.pi/extensions/` entries load only after you trust the project. The installer uses the global path so governance is on before any repo is opened.

## Learn more

- [What ACP can see and control in pi](https://agenticcontrolplane.com/controls/pi): the controls reference
- [Which coding agent has the best native controls?](https://agenticcontrolplane.com/controls): the cross-harness comparison, and pi's place in it

## Test

```sh
npm test        # decision mapping, fail posture, unattended asks, receipt
npm run typecheck
npm run build   # emits dist/ (JS + .d.ts); prepack runs this from clean
```

MIT
