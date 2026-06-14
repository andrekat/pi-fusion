import { describe, expect, test } from "bun:test";
import { benchmarkCallCount, benchmarkConfig } from "../src/benchmark.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";
import { completionOptions, resolveUsableModel } from "../src/models.ts";
import { findLastFusionResult } from "../src/session.ts";
import type { CandidateAnswer, FusionResult } from "../src/types.ts";
import { annotateCandidateCompleteness, normalizeConfidence, normalizeStopReason } from "../src/utils.ts";

function minimalResult(finalAnswer = "final"): FusionResult {
	return {
		mode: "code",
		prompt: "prompt",
		panel: [],
		judgeModel: "openai-codex/gpt-5.5",
		finalModel: "openai-codex/gpt-5.5",
		judgeRaw: "{}",
		judge: {
			winner: "hybrid",
			critical_issues: [],
			strongest_points_from_a: [],
			strongest_points_from_b: [],
			must_include_from_a: [],
			must_include_from_b: [],
			synthesis_plan: [],
			unique_insights: [],
			contradictions: [],
			recommended_final_answer: "",
			confidence: 92,
			tests_or_checks_needed: [],
		},
		finalAnswer,
		durationMs: 1000,
		contextIncluded: true,
	};
}

describe("normalization helpers", () => {
	test("normalizes probability-style confidence to percentages", () => {
		expect(normalizeConfidence(0.94)).toBe(94);
		expect(normalizeConfidence("93%")).toBe(93);
		expect(normalizeConfidence(120)).toBe(100);
		expect(normalizeConfidence("not-a-number")).toBe(50);
	});

	test("normalizes provider stop reasons", () => {
		expect(normalizeStopReason("max_output_tokens")).toBe("length");
		expect(normalizeStopReason("END_TURN")).toBe("stop");
		expect(normalizeStopReason("tool_calls")).toBe("toolUse");
		expect(normalizeStopReason(undefined)).toBe("unknown");
	});

	test("tracks missing required sections without changing candidates otherwise", () => {
		const candidates: CandidateAnswer[] = [{ label: "A", modelRef: "m/a", role: "role", text: "# Recommendation\nDo it.\n\n## Why\nBecause.", durationMs: 1 }];
		const annotated = annotateCandidateCompleteness(candidates, ["Recommendation", "Why", "Top 3 risks"]);
		expect(annotated[0].missingRequiredSections).toEqual(["Top 3 risks"]);
		expect(candidates[0].missingRequiredSections).toBeUndefined();
	});
});

describe("config and benchmark caps", () => {
	test("merges config with current defaults and clamps numeric fields", () => {
		const config = normalizeConfig({
			panelModels: [" openai-codex/gpt-5.5 ", ""],
			includeConversation: false,
			conversationEntries: 200,
			maxContextChars: -1,
			panelMaxTokens: 50,
			reasoningEffort: "bogus",
			codeStrategy: "parallel",
		});

		expect(config.panelModels).toEqual(["openai-codex/gpt-5.5"]);
		expect(config.includeConversation).toBe(false);
		expect(config.conversationEntries).toBe(80);
		expect(config.maxContextChars).toBe(0);
		expect(config.panelMaxTokens).toBe(512);
		expect(config.reasoningEffort).toBe(DEFAULT_CONFIG.reasoningEffort);
		expect(config.codeStrategy).toBe("parallel");
	});

	test("benchmark config uses fixed caps and lower reasoning", () => {
		const source = { ...DEFAULT_CONFIG, includeConversation: true, showIntermediate: true, panelMaxTokens: 9999, judgeMaxTokens: 9999, finalMaxTokens: 9999, reasoningEffort: "high" as const };
		const quick = benchmarkConfig(source, "quick");
		const standard = benchmarkConfig(source, "standard");

		expect(quick.includeConversation).toBe(false);
		expect(quick.showIntermediate).toBe(false);
		expect(quick.panelMaxTokens).toBe(2200);
		expect(quick.judgeMaxTokens).toBe(900);
		expect(quick.finalMaxTokens).toBe(1200);
		expect(quick.reasoningEffort).toBe("low");
		expect(standard.reasoningEffort).toBe("medium");
		expect(benchmarkCallCount({ ...DEFAULT_CONFIG, panelModels: ["a", "b", "c"] }, [{ id: "x", title: "x", mode: "general", prompt: "x" }])).toBe(5);
	});
});

describe("model and session behavior", () => {
	test("completion options never send temperature", () => {
		const options = completionOptions({} as never, { maxTokens: 123, temperature: 0.7, reasoningEffort: "medium" }, undefined);
		expect(options.maxTokens).toBe(123);
		expect(options.reasoningEffort).toBe("medium");
		expect(options).not.toHaveProperty("temperature");

		const off = completionOptions({} as never, { maxTokens: 123, temperature: 0.7, reasoningEffort: "off" }, undefined);
		expect(off).not.toHaveProperty("temperature");
		expect(off).not.toHaveProperty("reasoningEffort");
	});

	test("provider fallback can resolve an authenticated model with the same id", () => {
		const openai = { provider: "openai", id: "gpt-5.5" };
		const codex = { provider: "openai-codex", id: "gpt-5.5" };
		const ctx = {
			modelRegistry: {
				find: (provider: string, id: string) => [openai, codex].find((model) => model.provider === provider && model.id === id),
				getAll: () => [openai, codex],
				getAvailable: () => [codex],
				hasConfiguredAuth: (model: typeof openai) => model.provider === "openai-codex",
			},
		} as any;

		expect(resolveUsableModel(ctx, "openai/gpt-5.5")?.ref).toBe("openai-codex/gpt-5.5");
	});

	test("finds current custom_message and legacy message custom entries", () => {
		const current = minimalResult("current");
		const legacy = minimalResult("legacy");
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{ type: "custom_message", customType: "pi-fusion", details: current },
					{ type: "message", message: { role: "custom", customType: "pi-fusion", details: legacy } },
				],
			},
		} as any;

		expect(findLastFusionResult(ctx)).toBe(legacy);
	});
});
