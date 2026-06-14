import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { runFusion } from "./fusion.ts";
import { choosePanelModels, chooseSingleModel, runCompletion } from "./models.ts";
import { formatBenchmarkResults, formatComparativeBenchmarkResults } from "./render.ts";
import type { BenchmarkCase, BenchmarkCaseResult, BenchmarkMessageDetails, ComparativeAnswer, ComparativeAnswerScore, ComparativeBenchmarkCaseResult, ComparativeBenchmarkMessageDetails, ComparativeJudgeDecision, FusionConfig, FusionMode, ResolvedModel } from "./types.ts";
import { asStringList, extractJsonObject, extractText, formatDuration, normalizeStopReason } from "./utils.ts";

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

function baselineSystemPrompt(mode: FusionMode, modelRef: string): string {
	const modeAdvice = mode === "plan"
		? "Focus on architecture, trade-offs, sequencing, dependencies, and risks."
		: mode === "code"
			? "Focus on code correctness, maintainability, edge cases, tests, and practical patch guidance. Do not claim you edited files."
			: mode === "review"
				? "Focus on review findings: correctness issues, regressions, missing tests, security/performance concerns, and what should be changed before merge."
				: "Focus on correctness, completeness, simplicity, maintainability, risks, and concrete next steps.";
	return `You are ${modelRef} running solo for a Pi Fusion baseline benchmark. Answer the user's task directly and independently. ${modeAdvice} If the prompt requests required sections or a word limit, obey it strictly.`;
}

function qualityJudgeSystemPrompt(): string {
	return `You are grading a Pi Fusion benchmark. The answers are anonymized and may be single-model baselines or a multi-model synthesis. Do not infer identity from style. Score only answer quality for the task. Prefer correctness, completeness, specificity, useful caveats, and testability over verbosity.

Return ONLY valid JSON with this exact shape. All numeric scores are 1-10, where 10 is best:
{
  "scores": {
    "answer_1": { "quality": 8, "correctness": 8, "completeness": 8, "clarity": 8, "actionability": 8, "notes": [] }
  },
  "ranking": ["answer_1"],
  "winner": "answer_1",
  "why_winner": "",
  "fusion_gain": "none | small | medium | large",
  "fusion_strengths": [],
  "fusion_weaknesses": []
}`;
}

function buildSoloTaskPrompt(prompt: string): string {
	return `<task>\n${prompt}\n</task>`;
}

async function runSingleBaseline(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	model: ResolvedModel,
	mode: FusionMode,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<ComparativeAnswer> {
	const started = Date.now();
	try {
		const response = await runCompletion(
			ctx,
			config,
			model,
			baselineSystemPrompt(mode, model.ref),
			buildSoloTaskPrompt(prompt),
			{ maxTokens: config.finalMaxTokens, temperature: config.finalTemperature, reasoningEffort: config.reasoningEffort },
			signal,
		);
		const text = extractText(response);
		if (!text) throw new Error("empty response");
		return {
			id: model.ref,
			label: model.ref,
			kind: "single",
			modelRef: model.ref,
			text,
			durationMs: Date.now() - started,
			stopReason: normalizeStopReason(response.stopReason),
			usage: response.usage,
		};
	} catch (error) {
		return {
			id: model.ref,
			label: model.ref,
			kind: "single",
			modelRef: model.ref,
			text: "",
			durationMs: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function blindAnswers(answers: ComparativeAnswer[], caseIndex: number): ComparativeAnswer[] {
	if (answers.length === 0) return [];
	const shift = caseIndex % answers.length;
	return [...answers.slice(shift), ...answers.slice(0, shift)].map((answer, index) => ({ ...answer, id: `answer_${index + 1}` }));
}

function buildQualityJudgePrompt(item: BenchmarkCase, answers: ComparativeAnswer[]): string {
	const required = item.requiredSections?.length ? `\nRequired sections: ${item.requiredSections.join(", ")}` : "";
	const blocks = answers.map((answer) => `<${answer.id}>\n${answer.error ? `ERROR: ${answer.error}` : answer.text}\n</${answer.id}>`).join("\n\n");
	return `<task>\n${item.prompt}${required}\n</task>\n\n<answers>\n${blocks}\n</answers>`;
}

function normalizeScore(value: unknown): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : 0;
	if (!Number.isFinite(numeric)) return 0;
	return Math.max(1, Math.min(10, numeric));
}

function normalizeAnswerScore(raw: unknown): ComparativeAnswerScore {
	const object = raw && typeof raw === "object" ? raw as Partial<ComparativeAnswerScore> : {};
	return {
		quality: normalizeScore(object.quality),
		correctness: normalizeScore(object.correctness),
		completeness: normalizeScore(object.completeness),
		clarity: normalizeScore(object.clarity),
		actionability: normalizeScore(object.actionability),
		notes: asStringList(object.notes),
	};
}

export function normalizeComparativeJudge(text: string, answerIds: string[]): ComparativeJudgeDecision {
	try {
		const raw = extractJsonObject(text) as Partial<ComparativeJudgeDecision> | undefined;
		if (!raw || typeof raw !== "object") throw new Error("missing JSON object");
		const scores: Record<string, ComparativeAnswerScore> = {};
		const rawScores = raw.scores && typeof raw.scores === "object" ? raw.scores as Record<string, unknown> : {};
		for (const id of answerIds) scores[id] = normalizeAnswerScore(rawScores[id]);
		const ranking = asStringList(raw.ranking).filter((id) => answerIds.includes(id));
		const winner = typeof raw.winner === "string" && answerIds.includes(raw.winner) ? raw.winner : ranking[0] || answerIds[0] || "answer_1";
		const fusionGain = raw.fusion_gain === "none" || raw.fusion_gain === "small" || raw.fusion_gain === "medium" || raw.fusion_gain === "large" ? raw.fusion_gain : "small";
		return {
			scores,
			ranking: ranking.length ? ranking : [...answerIds].sort((a, b) => (scores[b]?.quality ?? 0) - (scores[a]?.quality ?? 0)),
			winner,
			why_winner: typeof raw.why_winner === "string" ? raw.why_winner : "",
			fusion_gain: fusionGain,
			fusion_strengths: asStringList(raw.fusion_strengths),
			fusion_weaknesses: asStringList(raw.fusion_weaknesses),
		};
	} catch {
		const scores = Object.fromEntries(answerIds.map((id) => [id, normalizeAnswerScore({ quality: 5, correctness: 5, completeness: 5, clarity: 5, actionability: 5, notes: ["Judge did not return parseable JSON."] })]));
		return {
			scores,
			ranking: answerIds,
			winner: answerIds[0] || "answer_1",
			why_winner: "Judge did not return parseable JSON; treating comparison as inconclusive.",
			fusion_gain: "none",
			fusion_strengths: [],
			fusion_weaknesses: ["Comparison judge failed; inspect raw output."],
		};
	}
}

async function runComparativeBenchmarkCases(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	cases: BenchmarkCase[],
	signal: AbortSignal | undefined,
): Promise<ComparativeBenchmarkCaseResult[]> {
	const results: ComparativeBenchmarkCaseResult[] = [];
	for (let index = 0; index < cases.length; index++) {
		const item = cases[index];
		if (signal?.aborted) break;
		const started = Date.now();
		try {
			const panelModels = choosePanelModels(ctx, config);
			if (panelModels.length < 2) throw new Error("Need at least two configured or available models for comparison benchmark.");
			const judgeModel = chooseSingleModel(ctx, config.judgeModel, panelModels) ?? panelModels[0];
			const soloAnswers = await Promise.all(panelModels.map((model) => runSingleBaseline(ctx, config, model, item.mode, item.prompt, signal)));
			const fusionStarted = Date.now();
			const fusionResult = await runFusion(ctx, config, item.mode, item.prompt, signal, item.requiredSections ?? []);
			const fusionAnswer: ComparativeAnswer = {
				id: "fusion",
				label: "Fusion",
				kind: "fusion",
				text: fusionResult.finalAnswer,
				durationMs: Date.now() - fusionStarted,
				fusionResult,
			};
			const answers = blindAnswers([...soloAnswers, fusionAnswer], index);
			const judgeResponse = await runCompletion(
				ctx,
				config,
				judgeModel,
				qualityJudgeSystemPrompt(),
				buildQualityJudgePrompt(item, answers),
				{ maxTokens: config.judgeMaxTokens, temperature: config.judgeTemperature, reasoningEffort: config.reasoningEffort },
				signal,
			);
			const judgeRaw = extractText(judgeResponse);
			results.push({
				case: item,
				answers,
				judgeModel: judgeModel.ref,
				judgeRaw,
				judge: normalizeComparativeJudge(judgeRaw, answers.map((answer) => answer.id)),
				durationMs: Date.now() - started,
			});
		} catch (error) {
			results.push({
				case: item,
				answers: [],
				judgeModel: "n/a",
				judgeRaw: "",
				judge: normalizeComparativeJudge("", []),
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

export async function runComparativeBenchmarkCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const profile = args.trim().toLowerCase() || "quick";
	if (!["dry", "quick", "standard", "full"].includes(profile)) {
		ctx.ui.notify("Usage: /fuse-bench-compare [dry|quick|standard|full]", "warning");
		return;
	}

	const effectiveProfile = profile === "dry" ? "standard" : profile;
	const config = benchmarkConfig(loadConfig(ctx), effectiveProfile);
	const cases = benchmarkCasesForProfile(effectiveProfile);
	const panelCalls = Math.max(2, config.panelModels.length);
	const callsPerCase = panelCalls * 2 + 3;
	const plan = [
		`Profile: ${profile}`,
		`Cases: ${cases.length}`,
		`Estimated model calls: ${cases.length * callsPerCase} (${panelCalls} solo + ${panelCalls} fusion panel + fusion judge/final + quality judge per case)`,
		`Solo max tokens: ${config.finalMaxTokens}`,
		`Fusion panel max tokens: ${config.panelMaxTokens}`,
		`Judge max tokens: ${config.judgeMaxTokens}`,
		`Reasoning effort: ${config.reasoningEffort}`,
		`Baselines:\n${config.panelModels.map((model) => `  - ${model} solo`).join("\n")}\n  - Fusion combined`,
	].join("\n");

	if (profile === "dry") {
		pi.sendMessage({ customType: "pi-fusion-benchmark-compare", content: `## Pi Fusion solo-vs-fusion benchmark dry run\n\n\`\`\`text\n${plan}\n\`\`\``, display: true });
		return;
	}

	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Run solo-vs-fusion benchmark?", `${plan}\n\nThis will call real configured providers.`);
		if (!ok) return;
	}

	let results: ComparativeBenchmarkCaseResult[] | null = null;
	if (ctx.mode === "tui") {
		results = await ctx.ui.custom<ComparativeBenchmarkCaseResult[] | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Running solo-vs-fusion ${profile} benchmark (${cases.length} case${cases.length === 1 ? "" : "s"})...`);
			loader.onAbort = () => done(null);
			runComparativeBenchmarkCases(ctx, config, cases, loader.signal)
				.then(done)
				.catch((error) => {
					ctx.ui.notify(`pi-fusion comparison benchmark failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					done(null);
				});
			return loader;
		});
	} else {
		results = await runComparativeBenchmarkCases(ctx, config, cases, undefined);
	}

	if (!results) {
		ctx.ui.notify("pi-fusion comparison benchmark cancelled", "info");
		return;
	}

	pi.sendMessage<ComparativeBenchmarkMessageDetails>({
		customType: "pi-fusion-benchmark-compare",
		content: formatComparativeBenchmarkResults(profile, config, results),
		display: true,
		details: { profile, results },
	});
}

export async function runBenchmarkCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const trimmedArgs = args.trim().toLowerCase();
	if (trimmedArgs === "compare" || trimmedArgs.startsWith("compare ")) {
		return runComparativeBenchmarkCommand(pi, ctx, trimmedArgs.replace(/^compare\s*/, "") || "quick");
	}

	const profile = trimmedArgs || "quick";
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
