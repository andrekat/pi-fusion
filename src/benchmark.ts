import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { runFusion } from "./fusion.ts";
import { formatBenchmarkResults } from "./render.ts";
import type { BenchmarkCase, BenchmarkCaseResult, BenchmarkMessageDetails, FusionConfig } from "./types.ts";
import { formatDuration } from "./utils.ts";

export const BENCHMARK_LIMITS = {
	quick: { panelMaxTokens: 2200, judgeMaxTokens: 900, finalMaxTokens: 1200, reasoningEffort: "low" as const },
	standard: { panelMaxTokens: 2200, judgeMaxTokens: 900, finalMaxTokens: 1200, reasoningEffort: "medium" as const },
	full: { panelMaxTokens: 2200, judgeMaxTokens: 900, finalMaxTokens: 1200, reasoningEffort: "medium" as const },
};

export const BENCHMARK_CASES: BenchmarkCase[] = [
	{
		id: "bounded-architecture",
		title: "Bounded architecture trade-off",
		mode: "plan",
		prompt:
			"A Pi extension stores user settings in JSON and runs 4 model calls per command. It now needs per-project overrides, cancellation, and a future benchmark mode. Choose between: (A) one file with helpers, (B) small modules, or (C) a tiny internal service object. Use exactly these sections: Recommendation, Why, Rejected alternatives, Top 3 risks. Keep it under 550 words.",
		requiredSections: ["Recommendation", "Why", "Rejected alternatives", "Top 3 risks"],
	},
	{
		id: "cache-debug",
		title: "Small debugging/code reasoning task",
		mode: "code",
		prompt:
			"Find the bug and propose the smallest safe fix plus tests. TypeScript snippet:\n\n```ts\ntype Entry = { key: string; value: string; expiresAt: number };\nconst cache = new Map<string, Entry>();\nexport function get(key: string, now = Date.now()) {\n  const entry = cache.get(key);\n  if (!entry) return undefined;\n  if (entry.expiresAt < now) cache.delete(entry.value);\n  return entry.value;\n}\nexport function set(key: string, value: string, ttlMs: number, now = Date.now()) {\n  cache.set(key, { key, value, expiresAt: now + ttlMs });\n}\n```\n\nAssume callers rely on expired entries returning undefined immediately.",
	},
	{
		id: "diff-review",
		title: "Concise production review",
		mode: "review",
		prompt:
			"Review this diff for production risk. Return only high-signal findings and tests to add.\n\n```diff\n- const user = await db.user.findUnique({ where: { id } });\n+ const user = await db.user.findFirst({ where: { id: Number(id) } });\n  if (!user) return res.status(404).end();\n- if (user.orgId !== session.orgId) return res.status(403).end();\n+ if (!session.isAdmin && user.orgId !== session.orgId) return res.status(403).end();\n+ await audit.log('user_view', { viewer: session.userId, target: id });\n  return res.json(user);\n```",
	},
	{
		id: "is-this-dumb",
		title: "Approach sanity check",
		mode: "general",
		prompt:
			"Is this approach dumb? I want a CLI command that writes benchmark results into the same chat transcript instead of a separate file or database. Argue for/against it, name failure modes, and give a pragmatic recommendation for v0.1.",
	},
	{
		id: "migration-plan",
		title: "Tiny migration plan",
		mode: "plan",
		prompt:
			"Plan a zero-downtime migration for a single-user local CLI tool from ~/.tool/config.json to ~/.tool/config.v2.json with rollback. Constraints: no daemon, no DB, users may kill the process mid-write. Give ordered steps and validation checks. Keep it concise.",
	},
];

export function benchmarkConfig(config: FusionConfig, profile: string): FusionConfig {
	const limits = BENCHMARK_LIMITS[profile as keyof typeof BENCHMARK_LIMITS] ?? BENCHMARK_LIMITS.standard;
	return {
		...config,
		includeConversation: false,
		// Fixed benchmark caps, independent of the user's normal config. This keeps
		// results comparable and avoids old saved 1200-token caps silently persisting.
		panelMaxTokens: limits.panelMaxTokens,
		judgeMaxTokens: limits.judgeMaxTokens,
		finalMaxTokens: limits.finalMaxTokens,
		showIntermediate: false,
		reasoningEffort: limits.reasoningEffort,
	};
}

export function benchmarkCasesForProfile(profile: string): BenchmarkCase[] {
	switch (profile) {
		case "quick":
			return BENCHMARK_CASES.slice(0, 1);
		case "full":
			return BENCHMARK_CASES;
		case "standard":
		default:
			return BENCHMARK_CASES.slice(0, 3);
	}
}

export function benchmarkCallCount(config: FusionConfig, cases: BenchmarkCase[]): number {
	const panelCalls = Math.max(2, config.panelModels.length);
	return cases.length * (panelCalls + 2);
}

function formatBenchmarkPlan(config: FusionConfig, cases: BenchmarkCase[], profile: string): string {
	return [
		`Profile: ${profile}`,
		`Cases: ${cases.length}`,
		`Estimated model calls: ${benchmarkCallCount(config, cases)} (${Math.max(2, config.panelModels.length)} panel + judge + final per case)`,
		`Panel max tokens: ${config.panelMaxTokens}`,
		`Judge max tokens: ${config.judgeMaxTokens}`,
		`Final max tokens: ${config.finalMaxTokens}`,
		`Conversation context: off for benchmark`,
		`Reasoning effort: ${config.reasoningEffort}`,
		`Models:\n${config.panelModels.map((model) => `  - panel: ${model}`).join("\n")}\n  - judge: ${config.judgeModel || "(auto)"}\n  - final: ${config.finalModel || "(auto)"}`,
		`Cases:\n${cases.map((item, index) => `  ${index + 1}. ${item.title} (${item.mode})`).join("\n")}`,
	].join("\n");
}

async function runBenchmarkCases(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	cases: BenchmarkCase[],
	signal: AbortSignal | undefined,
): Promise<BenchmarkCaseResult[]> {
	const results: BenchmarkCaseResult[] = [];
	for (const item of cases) {
		if (signal?.aborted) break;
		const started = Date.now();
		try {
			const result = await runFusion(ctx, config, item.mode, item.prompt, signal, item.requiredSections ?? []);
			results.push({ case: item, result, durationMs: Date.now() - started });
		} catch (error) {
			results.push({
				case: item,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - started,
			});
		}
	}
	return results;
}

export async function runBenchmarkCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const profile = args.trim().toLowerCase() || "quick";
	if (!["dry", "quick", "standard", "full"].includes(profile)) {
		ctx.ui.notify("Usage: /fuse-bench [dry|quick|standard|full]", "warning");
		return;
	}

	const effectiveProfile = profile === "dry" ? "standard" : profile;
	const config = benchmarkConfig(loadConfig(ctx), effectiveProfile);
	const cases = benchmarkCasesForProfile(effectiveProfile);
	const plan = formatBenchmarkPlan(config, cases, profile);
	if (profile === "dry") {
		pi.sendMessage({ customType: "pi-fusion-benchmark", content: `## Pi Fusion benchmark dry run\n\n\`\`\`text\n${plan}\n\`\`\``, display: true });
		return;
	}

	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Run pi-fusion benchmark?", `${plan}\n\nThis will call real configured providers.`);
		if (!ok) return;
	}

	let results: BenchmarkCaseResult[] | null = null;
	if (ctx.mode === "tui") {
		results = await ctx.ui.custom<BenchmarkCaseResult[] | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Running pi-fusion ${profile} benchmark (${cases.length} case${cases.length === 1 ? "" : "s"})...`);
			loader.onAbort = () => done(null);
			runBenchmarkCases(ctx, config, cases, loader.signal)
				.then(done)
				.catch((error) => {
					ctx.ui.notify(`pi-fusion benchmark failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					done(null);
				});
			return loader;
		});
	} else {
		results = await runBenchmarkCases(ctx, config, cases, undefined);
	}

	if (!results) {
		ctx.ui.notify("pi-fusion benchmark cancelled", "info");
		return;
	}

	pi.sendMessage<BenchmarkMessageDetails>({
		customType: "pi-fusion-benchmark",
		content: formatBenchmarkResults(profile, config, results),
		display: true,
		details: { profile, results },
	});
}
