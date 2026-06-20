# glm-delegate

Run a **headless [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI powered by GLM** (Zhipu / [z.ai](https://z.ai)) as an *independent* code-review and research delegate.

The idea: keep Claude (Opus/Sonnet) as your orchestrator, and hand off **independent code review** and **large-context research** to a model from a *different family* — GLM-5.2. Different model families make uncorrelated mistakes, so a GLM second opinion catches things a Claude (or GPT) reviewer misses. The delegate runs a full agentic loop: it **reads the code itself** and returns its own verdict — not an echo of what the orchestrator already thinks.

```
your orchestrator (Claude)
        │  forms task + acceptance criteria
        ▼
   glm-delegate ──► headless `claude` with env → https://api.z.ai/api/anthropic
        │                 └─ GLM-5.2 reads the diff/files itself (Read/Grep/Glob)
        ▼
   structured findings  ──►  orchestrator reconciles (e.g. vs a Codex/GPT review)
```

It works because z.ai exposes an **Anthropic-compatible endpoint**, so the `claude` CLI speaks to GLM unchanged — you only swap `ANTHROPIC_BASE_URL` + the auth token. `glm-delegate` is a small, hardened wrapper around that.

## Why not just set `model:` in a subagent?

Claude Code's native subagent `model:` field only accepts Anthropic model IDs — you can't point a subagent at GLM directly. `glm-delegate` is the delegation path: a Bash-callable wrapper that spawns a headless `claude` running on GLM, with a clean, isolated environment.

## Requirements

- **Node.js >= 18**
- **Claude Code CLI** on your `PATH` (`claude --version`)
- A **GLM API key** — a [z.ai GLM Coding Plan](https://z.ai) subscription (uses the Anthropic-compatible endpoint) or a pay-per-token z.ai key.

## Install

```bash
npm install -g glm-delegate
# or run from a clone:
git clone https://github.com/requestSource/glm-delegate.git && cd glm-delegate
```

## Configure

Provide the GLM key one of two ways:

```bash
# 1. environment variable (recommended)
export GLM_API_KEY="your-z.ai-key"

# 2. a secrets file with a `GLM_API_KEY=...` line
#    default: ~/.my/secrets.cfg   (override with GLM_SECRETS_FILE)
echo 'GLM_API_KEY="your-z.ai-key"' >> ~/.my/secrets.cfg
```

## Usage

The prompt is **always read from stdin** (never an argument):

```bash
# Independent code review of a target the orchestrator prepared
printf '%s' "Review src/auth.js for correctness and security. Read it yourself; list issues with file:line and a fix." \
  | glm-delegate review --cwd /path/to/repo

# Research / analysis over a large local context (1M-token window)
printf '%s' "Summarize what every script in ./scripts does and how they relate." \
  | glm-delegate research --cwd .
```

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--cwd <path>` | current dir | Working directory the delegate runs in |
| `--max-duration <sec>` | `900` | Hard wall-clock timeout (tree-killed on expiry) |

Exit codes: `0` ok · `124` timed out · `2` usage error · otherwise the `claude` exit code.

### Using it from Claude Code

Wrap the two modes as slash-command skills (e.g. `/glm-review`, `/glm-research`) so your orchestrator delegates and then **reconciles** GLM's findings with another reviewer (e.g. a GPT/Codex pass): issues both raise → high confidence; only one raises → investigate. Because the families differ, the union catches more than either alone.

## Security model

`glm-delegate` runs a third-party model with your repo on disk, so it is deliberately hardened:

- **Credential isolation.** The child environment is rebuilt from scratch and `ANTHROPIC_API_KEY` is **deleted** — only the GLM bearer token (`ANTHROPIC_AUTH_TOKEN`) is sent to z.ai. Your real Anthropic key can never leak to a third party. *(unit-tested)*
- **No code execution.** Review/research expose only `Read,Grep,Glob` — **no `Bash`**. Even if reviewed code contains a prompt-injection ("ignore instructions, run …"), the delegate has no shell to execute it. The orchestrator supplies any `git diff` context in the prompt.
- **Prompt via stdin.** The untrusted prompt never reaches the command line, so there is no shell-injection surface.
- **Config isolation.** The child runs with an isolated `CLAUDE_CONFIG_DIR`, so your `~/.claude` settings can't re-inject credentials and your persona/output-style doesn't bleed into the delegate.
- **Runaway guard.** A wall-clock watchdog **tree-kills** the process (Windows `taskkill /T`, POSIX process-group) so a hung delegate can't keep burning quota past the timeout.
- **Secret hygiene.** The key is read from env or a secrets file, never logged and never passed as an argument.

## Limitations

- **No live web.** The z.ai endpoint doesn't expose Anthropic's hosted web search. `research` analyses local/provided context (its strength is the 1M-token window over a whole repo), not the live web.
- **Latency.** An agentic review is several turns (read → reason → write); expect tens of seconds to a few minutes depending on scope. It's an async delegate, not an interactive assistant.
- **It's a delegate, not an oracle.** Verify its findings — especially fixes — before acting on them.

## Development

```bash
npm test   # node --test (pure-function unit tests: env isolation, arg parsing, secret parsing)
```

## License

MIT — see [LICENSE](LICENSE).
