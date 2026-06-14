# pi-fusion

`pi-fusion` is a Pi extension that runs one prompt through multiple real Pi child executions, asks a judge model to evaluate the answers, then asks a final writer model to synthesize the useful answer back into the Pi session.

I checked npm/GitHub/web search for an exact `pi-fusion` package and did not find one. Related prior art exists: OpenRouter Fusion, plus Pi OpenRouter provider extensions.

## Commands

- `/fuse <prompt>` — general multi-model deliberation
- `/fuse-plan <prompt>` — architecture / planning / trade-off mode
- `/fuse-code <prompt>` — code/refactor mode; defaults to proposer + critic flow
- `/fuse-review <prompt>` — diff / PR / bugfix review mode
- `/fuse-settings` — TUI settings for panel, judge, final writer, context, and strategy
- `/fuse-status` — show current config
- `/fuse-bench [dry|quick|standard|full]` — bounded real-provider benchmark suite
- `/fuse-bench compare [dry|quick|standard|full]` or `/fuse-bench-compare [dry|quick|standard|full]` — compare each panel model solo against Fusion synthesis
- `/fuse-view` — open the last Fusion answer in a tabbed TUI viewer

## Default model setup

```json
{
  "panelModels": [
    "anthropic/claude-opus-4-8",
    "openai-codex/gpt-5.5"
  ],
  "judgeModel": "openai-codex/gpt-5.5",
  "finalModel": "openai-codex/gpt-5.5",
  "panelExecution": "pi"
}
```

Model refs are `provider/model-id`. Defaults use Pi's subscription-friendly OpenAI Codex provider (`openai-codex/gpt-5.5`) plus Claude Opus. If you configure an unauthenticated provider/model, pi-fusion will try an authenticated provider with the same model id when one exists. For OpenRouter models with slashes in the model id, use `openrouter/<model-id>`, for example `openrouter/anthropic/claude-opus-4.8`.

## Install / run locally

From this repo:

```bash
bun install
bun run check
pi -e .
```

Then in Pi:

```text
/fuse-settings
/fuse-plan should we split this service into modules or keep it simple?
/fuse-code propose the safest way to refactor the auth middleware
/fuse-review review the current migration plan for production risks
/fuse-view
/fuse-bench dry
/fuse-bench quick
/fuse-bench-compare dry
/fuse-bench-compare quick
```

## Config files

Global config is saved to:

```text
~/.pi/agent/pi-fusion.json
```

A trusted project may override it with:

```text
.pi/pi-fusion.json
```

## Flow

1. Panel models run as real non-interactive Pi child agents (`pi -p`) by default.
2. Each child agent forks the current session when available, uses the selected model, loads normal Pi project context, and has normal Pi tool privileges for the trusted project.
3. `/fuse-code` can use a smarter proposer + critic strategy.
4. Judge returns forced JSON with winner, issues, contradictions, confidence, and tests/checks.
5. Final writer produces the answer shown in the Pi session.

The judge prompt explicitly avoids “just summarize” behavior. The panel execution mode can be changed to direct model completions by setting `panelExecution` to `"completion"`, but the default is `"pi"` so panelists can inspect files instead of guessing from chat text alone.

## Benchmarking without lighting money on fire

`/fuse-bench` uses your configured flagship providers, but keeps the benchmark prompts compact, disables conversation context, and caps outputs:

- panel: max 2200 tokens
- judge: max 900 tokens
- final: max 1200 tokens
- benchmark reasoning effort is forced lower than normal runs (`low` for quick, `medium` for standard/full)

Profiles:

- `/fuse-bench dry` — no model calls; shows cases, models, and estimated call count
- `/fuse-bench quick` — 1 case, usually 4 model calls with the default 2-panel setup
- `/fuse-bench standard` — 3 cases
- `/fuse-bench full` — 5 cases

The benchmark reports latency, judge confidence, winner, required-section completeness, normalized stop reasons, critical issue count, and estimated API cost from provider usage metadata when available. In Pi-execution mode, reported cost can exclude child Pi panel runs because the child process returns text, not structured usage. Expand the benchmark message to inspect the full final synthesis, judge JSON/raw output, and full candidate answers. It is a lightweight signal, not a formal eval.

### Solo vs Fusion quality benchmark

`/fuse-bench-compare` runs the same benchmark cases three ways with the default setup:

1. Claude Opus solo
2. OpenAI Codex GPT-5.5 solo
3. Fusion: Claude + GPT-5.5 panel → judge → final synthesis

Then a blind quality judge scores the anonymized outputs on correctness, completeness, clarity, actionability, and overall quality.

Example standard run with the default model pair, captured in completion-mode benchmarking (`/fuse-bench-compare standard`, 3 cases). Pi-execution mode is more grounded but may have different latency/cost because child Pi usage metadata is not always available:

```text
Quality score, 1–10 higher is better

Fusion                           ██████████████░░ 9.0  wins:2/3  avg:65.0s  avg cost:$0.143
openai-codex/gpt-5.5             █████████████░░░ 8.3  wins:1/3  avg:16.6s  avg cost:$0.023
anthropic/claude-opus-4-8        █████████████░░░ 8.0  wins:0/3  avg:18.2s  avg cost:$0.031
```

| Approach | Avg quality | Wins | Avg latency | Avg reported cost | Takeaway |
|---|---:|---:|---:|---:|---|
| Fusion | 9.0 | 2/3 | 65.0s | $0.143 | Best quality on planning/review tasks; pays a latency/cost premium. |
| OpenAI Codex GPT-5.5 solo | 8.3 | 1/3 | 16.6s | $0.023 | Fastest/cheapest; won the small bugfix case outright. |
| Claude Opus 4.8 solo | 8.0 | 0/3 | 18.2s | $0.031 | Strong solo baseline, but Fusion kept more cross-model caveats. |

Treat this as directional: it measures whether Fusion improves the judged answer, while also showing when a single flagship model is already enough. In `panelExecution: "pi"` mode, reported cost can exclude child Pi runs when provider usage metadata is not exposed by the child process.
