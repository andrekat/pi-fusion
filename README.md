# pi-fusion

`pi-fusion` is a Pi extension that runs one prompt through multiple panel models, asks a judge model to evaluate the answers, then asks a final writer model to synthesize the useful answer back into the Pi session.

I checked npm/GitHub/web search for an exact `pi-fusion` package and did not find one. Related prior art exists: OpenRouter Fusion, plus Pi OpenRouter provider extensions.

## Commands

- `/fuse <prompt>` — general multi-model deliberation
- `/fuse-plan <prompt>` — architecture / planning / trade-off mode
- `/fuse-code <prompt>` — code/refactor mode; defaults to proposer + critic flow
- `/fuse-review <prompt>` — diff / PR / bugfix review mode
- `/fuse-settings` — TUI settings for panel, judge, final writer, context, and strategy
- `/fuse-status` — show current config
- `/fuse-bench [dry|quick|standard|full]` — bounded real-provider benchmark suite
- `/fuse-view` — open the last Fusion answer in a tabbed TUI viewer

## Default model setup

```json
{
  "panelModels": [
    "anthropic/claude-opus-4-8",
    "opencode/gpt-5.5-pro"
  ],
  "judgeModel": "opencode/gpt-5.5-pro",
  "finalModel": "opencode/gpt-5.5-pro"
}
```

Model refs are `provider/model-id`. Defaults prefer subscription-friendly `opencode/gpt-*` refs. If you configure `openai/gpt-5.5-pro` but have no OpenAI API key, pi-fusion will try an authenticated provider with the same model id, such as `opencode/gpt-5.5-pro`. For OpenRouter models with slashes in the model id, use `openrouter/<model-id>`, for example `openrouter/anthropic/claude-opus-4.8`.

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

1. Panel models answer independently in parallel.
2. `/fuse-code` can use a smarter proposer + critic strategy.
3. Judge returns forced JSON with winner, issues, contradictions, confidence, and tests/checks.
4. Final writer produces the answer shown in the Pi session.

The judge prompt explicitly avoids “just summarize” behavior.

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

The benchmark reports latency, judge confidence, winner, required-section completeness, normalized stop reasons, critical issue count, and estimated API cost from provider usage metadata when available. Expand the benchmark message to inspect the full final synthesis, judge JSON/raw output, and full candidate answers. It is a lightweight signal, not a formal eval.
