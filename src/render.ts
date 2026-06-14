import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { BenchmarkCase, BenchmarkCaseResult, BenchmarkMessageDetails, CandidateAnswer, FusionConfig, FusionResult } from "./types.ts";
import { bulletList, estimatedCost, excerpt, formatCost, formatDuration, tableCell } from "./utils.ts";

export function formatFusionMessage(result: FusionResult, showIntermediate: boolean): string {
	const panelSummary = result.panel
		.map((candidate) => {
			const status = candidate.error ? `failed: ${candidate.error}` : `ok (${formatDuration(candidate.durationMs)})`;
			return `- ${candidate.label}: ${candidate.modelRef} — ${status}`;
		})
		.join("\n");

	const checks = result.judge.tests_or_checks_needed.length
		? `\n\n**Tests/checks suggested by judge**\n${result.judge.tests_or_checks_needed.map((item) => `- ${item}`).join("\n")}`
		: "";

	let text = `## Pi Fusion (${result.mode})\n\n${result.finalAnswer}\n\n---\n**Fusion metadata**\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n- Judge: ${result.judgeModel}${result.judgeDurationMs ? ` (${formatDuration(result.judgeDurationMs)})` : ""}\n- Final writer: ${result.finalModel}${result.finalDurationMs ? ` (${formatDuration(result.finalDurationMs)})` : ""}\n- Duration: ${formatDuration(result.durationMs)}\n- Estimated API cost: ${formatCost(estimatedCost(result))}\n- Conversation context: ${result.contextIncluded ? "included" : "not included"}\n\n**Panel**\n${panelSummary}${checks}`;

	if (showIntermediate) {
		text += `\n\n<details>\n<summary>Judge JSON / raw output</summary>\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\nRaw:\n\n\`\`\`\n${result.judgeRaw}\n\`\`\`\n</details>`;
	}
	return text;
}

export function detailsMarkdown(result: FusionResult): string {
	const candidates = result.panel
		.map((candidate) => `### ${candidate.label}: ${candidate.modelRef}\n\n${candidate.error ? `Error: ${candidate.error}` : candidate.text}`)
		.join("\n\n---\n\n");
	return `\n\n---\n\n## Expanded Fusion Details\n\n### Judge\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\n### Raw Judge Output\n\n\`\`\`\n${result.judgeRaw}\n\`\`\`\n\n## Candidate Answers\n\n${candidates}`;
}

export function fusionOverviewMarkdown(result: FusionResult): string {
	const panel = result.panel
		.map((candidate) => `- ${candidate.label}: ${candidate.modelRef} — ${candidate.error ? `failed: ${candidate.error}` : `ok, ${formatDuration(candidate.durationMs)}${candidate.stopReason ? `, stop:${candidate.stopReason}` : ""}`}`)
		.join("\n");
	return `# Pi Fusion overview\n\n- Mode: ${result.mode}\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n- Judge: ${result.judgeModel}${result.judgeDurationMs ? ` (${formatDuration(result.judgeDurationMs)})` : ""}\n- Final writer: ${result.finalModel}${result.finalDurationMs ? ` (${formatDuration(result.finalDurationMs)})` : ""}\n- Duration: ${formatDuration(result.durationMs)}\n- Estimated API cost: ${formatCost(estimatedCost(result))}\n\n## Panel\n${panel}\n\n## Final synthesis\n\n${result.finalAnswer}`;
}

export function fusionWinnerMarkdown(result: FusionResult): string {
	return `# Winner / synthesis\n\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n\n## Critical issues / caveats\n${bulletList(result.judge.critical_issues)}\n\n## Must include from A\n${bulletList(result.judge.must_include_from_a)}\n\n## Must include from B\n${bulletList(result.judge.must_include_from_b)}\n\n## Hybrid synthesis plan\n${bulletList(result.judge.synthesis_plan)}\n\n## Unique insights\n${bulletList(result.judge.unique_insights)}\n\n## Contradictions\n${bulletList(result.judge.contradictions)}\n\n## Tests/checks\n${bulletList(result.judge.tests_or_checks_needed)}`;
}

export function fusionCandidatesMarkdown(result: FusionResult): string {
	return result.panel
		.map((candidate) => `# Candidate ${candidate.label}: ${candidate.modelRef}\n\n- Role: ${candidate.role}\n- Status: ${candidate.error ? `failed: ${candidate.error}` : "ok"}\n- Duration: ${formatDuration(candidate.durationMs)}\n${candidate.stopReason ? `- Stop reason: ${candidate.stopReason}\n` : ""}\n${candidate.error ? "" : candidate.text}`)
		.join("\n\n---\n\n");
}

export function fusionRawMarkdown(result: FusionResult): string {
	return `# Raw judge artifacts\n\n## Parsed judge JSON\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\n## Raw judge output\n\n\`\`\`\n${result.judgeRaw}\n\`\`\``;
}

function formatCandidateStats(candidate: CandidateAnswer): string {
	const cost = candidate.usage?.cost.total ? `, ${formatCost(candidate.usage.cost.total)}` : "";
	const tokens = candidate.usage?.totalTokens ? `, ${candidate.usage.totalTokens.toLocaleString()} tokens` : "";
	const stop = candidate.stopReason ? `, stop:${candidate.stopReason}` : "";
	return `${candidate.modelRef} — ${candidate.error ? `failed: ${candidate.error}` : `ok, ${formatDuration(candidate.durationMs)}${tokens}${cost}${stop}`}`;
}

function formatCompleteness(candidates: CandidateAnswer[]): string {
	const tracked = candidates.filter((candidate) => candidate.missingRequiredSections !== undefined);
	if (tracked.length === 0) return "No required sections configured for this case.";
	return tracked
		.map((candidate) => {
			const missing = candidate.missingRequiredSections ?? [];
			return `- ${candidate.label}: ${missing.length === 0 ? "complete" : `missing ${missing.join(", ")}`}`;
		})
		.join("\n");
}

function missingSectionCount(candidates: CandidateAnswer[]): number {
	return candidates.reduce((sum, candidate) => sum + (candidate.missingRequiredSections?.length ?? 0), 0);
}

function benchmarkCallCount(config: FusionConfig, cases: BenchmarkCase[]): number {
	const panelCalls = Math.max(2, config.panelModels.length);
	return cases.length * (panelCalls + 2);
}

function formatBenchmarkCaseDetails(item: BenchmarkCaseResult, index: number): string {
	if (!item.result) {
		return `### ${index + 1}. ${item.case.title}\n\nFailed after ${formatDuration(item.durationMs)}:\n\n\`\`\`text\n${item.error || "unknown error"}\n\`\`\``;
	}

	const result = item.result;
	const panelMap = result.panel.map((candidate) => `- ${candidate.label}: ${formatCandidateStats(candidate)}`).join("\n");
	const candidateExcerpts = result.panel
		.map((candidate) => {
			if (candidate.error) return `#### ${candidate.label}: ${candidate.modelRef}\n\nFailed: ${candidate.error}`;
			return `#### ${candidate.label}: ${candidate.modelRef}\n\n${excerpt(candidate.text)}`;
		})
		.join("\n\n");

	return `### ${index + 1}. ${item.case.title}\n\n**Prompt**\n\n${item.case.prompt}\n\n**Panel mapping**\n${panelMap}\n\n**Required-section completeness**\n${formatCompleteness(result.panel)}\n\n**Judge verdict**\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n- Judge model: ${result.judgeModel}${result.judgeDurationMs ? ` (${formatDuration(result.judgeDurationMs)})` : ""}\n- Final writer: ${result.finalModel}${result.finalDurationMs ? ` (${formatDuration(result.finalDurationMs)})` : ""}\n- Estimated case cost: ${formatCost(estimatedCost(result))}\n\n**Critical issues / caveats**\n${bulletList(result.judge.critical_issues)}\n\n**Strongest points from A**\n${bulletList(result.judge.strongest_points_from_a)}\n\n**Strongest points from B**\n${bulletList(result.judge.strongest_points_from_b)}\n\n**Must include from A**\n${bulletList(result.judge.must_include_from_a)}\n\n**Must include from B**\n${bulletList(result.judge.must_include_from_b)}\n\n**Hybrid synthesis plan**\n${bulletList(result.judge.synthesis_plan)}\n\n**Unique insights / useful extras**\n${bulletList(result.judge.unique_insights)}\n\n**Contradictions**\n${bulletList(result.judge.contradictions)}\n\n**Tests/checks suggested**\n${bulletList(result.judge.tests_or_checks_needed)}\n\n**Final synthesis excerpt**\n\n${excerpt(result.finalAnswer, 1200)}\n\n**Candidate answer excerpts**\n\n${candidateExcerpts}\n\n_Expand this benchmark message to see the full final answer, raw judge output, and full candidate answers._`;
}

export function formatBenchmarkExpandedDetails(details: BenchmarkMessageDetails): string {
	const sections = details.results.map((item, index) => {
		if (!item.result) {
			return `## ${index + 1}. ${item.case.title} — failed\n\n\`\`\`text\n${item.error || "unknown error"}\n\`\`\``;
		}

		const result = item.result;
		const candidates = result.panel
			.map((candidate) => `### ${candidate.label}: ${candidate.modelRef}\n\n${candidate.error ? `Failed: ${candidate.error}` : candidate.text}`)
			.join("\n\n---\n\n");

		return `## ${index + 1}. ${item.case.title} — full artifacts\n\n### Full final synthesis\n\n${result.finalAnswer}\n\n### Judge JSON\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\n### Raw judge output\n\n\`\`\`\n${result.judgeRaw}\n\`\`\`\n\n### Full candidate answers\n\n${candidates}`;
	});

	return `\n\n---\n\n# Expanded benchmark artifacts\n\n${sections.join("\n\n---\n\n")}`;
}

export function formatBenchmarkResults(profile: string, config: FusionConfig, results: BenchmarkCaseResult[]): string {
	const successful = results.filter((item) => item.result);
	const totalDuration = results.reduce((sum, item) => sum + item.durationMs, 0);
	const totalCost = successful.reduce((sum, item) => sum + estimatedCost(item.result!), 0);
	const avgConfidence = successful.length
		? successful.reduce((sum, item) => sum + item.result!.judge.confidence, 0) / successful.length
		: 0;

	const rows = results
		.map((item, index) => {
			if (!item.result) {
				return `| ${index + 1} | ${tableCell(item.case.title)} | failed | - | ${formatDuration(item.durationMs)} | - | ${tableCell(item.error || "unknown")} |`;
			}
			const result = item.result;
			const issues = result.judge.critical_issues.length;
			const missing = missingSectionCount(result.panel);
			const notes = [`${issues} issue${issues === 1 ? "" : "s"}`];
			if (missing > 0) notes.push(`${missing} missing section${missing === 1 ? "" : "s"}`);
			return `| ${index + 1} | ${tableCell(item.case.title)} | ${Math.round(result.judge.confidence)}% | ${tableCell(result.judge.winner)} | ${formatDuration(result.durationMs)} | ${formatCost(estimatedCost(result))} | ${tableCell(notes.join(", "))} |`;
		})
		.join("\n");

	const details = results.map(formatBenchmarkCaseDetails).join("\n\n---\n\n");

	return `## Pi Fusion benchmark (${profile})\n\nThis is a lightweight benchmark using your configured flagship models, but with bounded prompts, no conversation context, and capped output tokens. Treat the score as a smoke/performance/value signal, not a formal eval.\n\n**Config**\n- Panel models: ${config.panelModels.join(", ")}\n- Judge: ${config.judgeModel || "(auto)"}\n- Final: ${config.finalModel || "(auto)"}\n- Output caps: panel ${config.panelMaxTokens}, judge ${config.judgeMaxTokens}, final ${config.finalMaxTokens}\n- Model calls attempted: ${benchmarkCallCount(config, results.map((item) => item.case))}\n\n**Summary**\n- Successful cases: ${successful.length}/${results.length}\n- Average judge confidence: ${successful.length ? `${Math.round(avgConfidence)}%` : "n/a"}\n- Total duration: ${formatDuration(totalDuration)}\n- Estimated total API cost: ${formatCost(totalCost)}\n\n| # | Case | Confidence | Winner | Time | Cost | Notes |\n|---:|---|---:|---|---:|---:|---|\n${rows}\n\n## Per-case comparison notes\n\n${details}`;
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<FusionResult>("pi-fusion", (message, options, theme) => {
		const base = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		const result = message.details;
		const text = options.expanded && result ? `${base}${detailsMarkdown(result)}` : `${base}\n\n_Tip: run /fuse-view for a tabbed viewer, or expand this message for raw details._`;
		const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
		try {
			box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		} catch {
			box.addChild(new Text(theme.fg("customMessageLabel", "pi-fusion") + "\n" + text, 0, 0));
		}
		return box;
	});

	pi.registerMessageRenderer<BenchmarkMessageDetails>("pi-fusion-benchmark", (message, options, theme) => {
		const base = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		const text = options.expanded && message.details ? `${base}${formatBenchmarkExpandedDetails(message.details)}` : base;
		const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
		try {
			box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		} catch {
			box.addChild(new Text(theme.fg("customMessageLabel", "pi-fusion benchmark") + "\n" + text, 0, 0));
		}
		return box;
	});
}
