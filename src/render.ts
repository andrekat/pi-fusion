import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { BenchmarkCase, BenchmarkCaseResult, BenchmarkMessageDetails, CandidateAnswer, ComparativeAnswer, ComparativeBenchmarkCaseResult, ComparativeBenchmarkMessageDetails, FusionConfig, FusionResult } from "./types.ts";
import { bulletList, estimatedCost, excerpt, formatCost, formatDuration, tableCell } from "./utils.ts";

export function formatFusionMessage(result: FusionResult, showIntermediate: boolean): string {
	const panelSummary = result.panel
		.map((candidate) => {
			const status = candidate.error ? `failed: ${candidate.error}` : `ok (${formatDuration(candidate.durationMs)})`;
			const execution = candidate.execution ? ` via ${candidate.execution}` : "";
			return `- ${candidate.label}: ${candidate.modelRef}${execution} — ${status}`;
		})
		.join("\n");

	const checks = result.judge.tests_or_checks_needed.length
		? `\n\n**Tests/checks suggested by judge**\n${result.judge.tests_or_checks_needed.map((item) => `- ${item}`).join("\n")}`
		: "";

	const costNote = result.panel.some((candidate) => candidate.execution === "pi") ? " (excludes Pi child panel usage)" : "";
	let text = `## Pi Fusion (${result.mode})\n\n${result.finalAnswer}\n\n---\n**Fusion metadata**\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n- Judge: ${result.judgeModel}${result.judgeDurationMs ? ` (${formatDuration(result.judgeDurationMs)})` : ""}\n- Final writer: ${result.finalModel}${result.finalDurationMs ? ` (${formatDuration(result.finalDurationMs)})` : ""}\n- Duration: ${formatDuration(result.durationMs)}\n- Estimated API cost: ${formatCost(estimatedCost(result))}${costNote}\n- Conversation context: ${result.contextIncluded ? "included" : "not included"}\n\n**Panel**\n${panelSummary}${checks}`;

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
		.map((candidate) => `- ${candidate.label}: ${candidate.modelRef}${candidate.execution ? ` via ${candidate.execution}` : ""} — ${candidate.error ? `failed: ${candidate.error}` : `ok, ${formatDuration(candidate.durationMs)}${candidate.stopReason ? `, stop:${candidate.stopReason}` : ""}`}`)
		.join("\n");
	const costNote = result.panel.some((candidate) => candidate.execution === "pi") ? " (excludes Pi child panel usage)" : "";
	return `# Pi Fusion overview\n\n- Mode: ${result.mode}\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n- Judge: ${result.judgeModel}${result.judgeDurationMs ? ` (${formatDuration(result.judgeDurationMs)})` : ""}\n- Final writer: ${result.finalModel}${result.finalDurationMs ? ` (${formatDuration(result.finalDurationMs)})` : ""}\n- Duration: ${formatDuration(result.durationMs)}\n- Estimated API cost: ${formatCost(estimatedCost(result))}${costNote}\n\n## Panel\n${panel}\n\n## Final synthesis\n\n${result.finalAnswer}`;
}

export function fusionWinnerMarkdown(result: FusionResult): string {
	return `# Winner / synthesis\n\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n\n## Critical issues / caveats\n${bulletList(result.judge.critical_issues)}\n\n## Must include from A\n${bulletList(result.judge.must_include_from_a)}\n\n## Must include from B\n${bulletList(result.judge.must_include_from_b)}\n\n## Hybrid synthesis plan\n${bulletList(result.judge.synthesis_plan)}\n\n## Unique insights\n${bulletList(result.judge.unique_insights)}\n\n## Contradictions\n${bulletList(result.judge.contradictions)}\n\n## Tests/checks\n${bulletList(result.judge.tests_or_checks_needed)}`;
}

export function fusionCandidatesMarkdown(result: FusionResult): string {
	return result.panel
		.map((candidate) => `# Candidate ${candidate.label}: ${candidate.modelRef}\n\n- Role: ${candidate.role}\n- Execution: ${candidate.execution || "completion"}\n- Status: ${candidate.error ? `failed: ${candidate.error}` : "ok"}\n- Duration: ${formatDuration(candidate.durationMs)}\n${candidate.stopReason ? `- Stop reason: ${candidate.stopReason}\n` : ""}\n${candidate.error ? "" : candidate.text}`)
		.join("\n\n---\n\n");
}

export function fusionRawMarkdown(result: FusionResult): string {
	return `# Raw judge artifacts\n\n## Parsed judge JSON\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\n## Raw judge output\n\n\`\`\`\n${result.judgeRaw}\n\`\`\``;
}

function formatCandidateStats(candidate: CandidateAnswer): string {
	const cost = candidate.usage?.cost.total ? `, ${formatCost(candidate.usage.cost.total)}` : "";
	const tokens = candidate.usage?.totalTokens ? `, ${candidate.usage.totalTokens.toLocaleString()} tokens` : "";
	const stop = candidate.stopReason ? `, stop:${candidate.stopReason}` : "";
	const execution = candidate.execution ? ` via ${candidate.execution}` : "";
	return `${candidate.modelRef}${execution} — ${candidate.error ? `failed: ${candidate.error}` : `ok, ${formatDuration(candidate.durationMs)}${tokens}${cost}${stop}`}`;
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

	return `## Pi Fusion benchmark (${profile})\n\nThis is a lightweight benchmark using your configured flagship models, but with bounded prompts, no conversation context, and capped output tokens. Treat the score as a smoke/performance/value signal, not a formal eval.\n\n**Config**\n- Panel models: ${config.panelModels.join(", ")}\n- Judge: ${config.judgeModel || "(auto)"}\n- Final: ${config.finalModel || "(auto)"}\n- Output caps: panel ${config.panelMaxTokens}, judge ${config.judgeMaxTokens}, final ${config.finalMaxTokens}\n- Panel execution: ${config.panelExecution}\n- Model calls attempted: ${benchmarkCallCount(config, results.map((item) => item.case))}\n\n**Summary**\n- Successful cases: ${successful.length}/${results.length}\n- Average judge confidence: ${successful.length ? `${Math.round(avgConfidence)}%` : "n/a"}\n- Total duration: ${formatDuration(totalDuration)}\n- Estimated total API cost: ${formatCost(totalCost)}${config.panelExecution === "pi" ? " (excludes Pi child panel usage)" : ""}\n\n| # | Case | Confidence | Winner | Time | Cost | Notes |\n|---:|---|---:|---|---:|---:|---|\n${rows}\n\n## Per-case comparison notes\n\n${details}`;
}

function comparativeAnswerCost(answer: ComparativeAnswer): number {
	if (answer.kind === "fusion" && answer.fusionResult) return estimatedCost(answer.fusionResult);
	return answer.usage?.cost.total ?? 0;
}

function answerDisplay(answer: ComparativeAnswer): string {
	return answer.kind === "fusion" ? "Fusion" : answer.modelRef || answer.label;
}

function scoreBar(score: number, width = 16): string {
	const clamped = Math.max(0, Math.min(10, score));
	const filled = Math.round((clamped / 10) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${clamped.toFixed(1)}`;
}

function scoreFor(item: ComparativeBenchmarkCaseResult, answer: ComparativeAnswer): number {
	return item.judge.scores[answer.id]?.quality ?? 0;
}

function averageByLabel(results: ComparativeBenchmarkCaseResult[]): Array<{ label: string; quality: number; durationMs: number; cost: number; wins: number; count: number }> {
	const aggregates = new Map<string, { label: string; quality: number; durationMs: number; cost: number; wins: number; count: number }>();
	for (const item of results) {
		const winner = item.judge.winner;
		for (const answer of item.answers) {
			const label = answerDisplay(answer);
			const existing = aggregates.get(label) ?? { label, quality: 0, durationMs: 0, cost: 0, wins: 0, count: 0 };
			existing.quality += scoreFor(item, answer);
			existing.durationMs += answer.durationMs;
			existing.cost += comparativeAnswerCost(answer);
			existing.wins += winner === answer.id ? 1 : 0;
			existing.count += 1;
			aggregates.set(label, existing);
		}
	}
	return Array.from(aggregates.values())
		.map((item) => ({
			...item,
			quality: item.count ? item.quality / item.count : 0,
			durationMs: item.count ? item.durationMs / item.count : 0,
			cost: item.count ? item.cost / item.count : 0,
		}))
		.sort((a, b) => b.quality - a.quality);
}

function formatComparativeChart(results: ComparativeBenchmarkCaseResult[]): string {
	const averages = averageByLabel(results);
	if (averages.length === 0) return "No successful comparison results.";
	return averages
		.map((item) => `${item.label.padEnd(32).slice(0, 32)} ${scoreBar(item.quality)}  wins:${item.wins}/${item.count}  avg:${formatDuration(item.durationMs)}  avg cost:${formatCost(item.cost)}`)
		.join("\n");
}

function formatComparativeExpandedDetails(details: ComparativeBenchmarkMessageDetails): string {
	const sections = details.results.map((item, index) => {
		if (item.error) {
			return `## ${index + 1}. ${item.case.title} — failed\n\n\`\`\`text\n${item.error}\n\`\`\``;
		}
		const answers = item.answers
			.map((answer) => `### ${answerDisplay(answer)} (${answer.id})\n\n${answer.error ? `Failed: ${answer.error}` : answer.text}`)
			.join("\n\n---\n\n");
		return `## ${index + 1}. ${item.case.title} — full comparison artifacts\n\n### Judge JSON\n\n\`\`\`json\n${JSON.stringify(item.judge, null, 2)}\n\`\`\`\n\n### Raw judge output\n\n\`\`\`\n${item.judgeRaw}\n\`\`\`\n\n### Full answers\n\n${answers}`;
	});
	return `\n\n---\n\n# Expanded solo-vs-fusion benchmark artifacts\n\n${sections.join("\n\n---\n\n")}`;
}

function formatComparativeCase(item: ComparativeBenchmarkCaseResult, index: number): string {
	if (item.error) {
		return `### ${index + 1}. ${item.case.title}\n\nFailed after ${formatDuration(item.durationMs)}:\n\n\`\`\`text\n${item.error}\n\`\`\``;
	}

	const rows = item.answers
		.map((answer) => {
			const score = item.judge.scores[answer.id];
			const notes = score?.notes?.length ? score.notes.join("; ") : "";
			return `| ${tableCell(answerDisplay(answer))} | ${answer.kind} | ${score?.quality?.toFixed(1) ?? "n/a"} | ${score?.correctness?.toFixed(1) ?? "n/a"} | ${score?.completeness?.toFixed(1) ?? "n/a"} | ${formatDuration(answer.durationMs)} | ${formatCost(comparativeAnswerCost(answer))} | ${tableCell(notes)} |`;
		})
		.join("\n");

	const winner = item.answers.find((answer) => answer.id === item.judge.winner);
	const fusion = item.answers.find((answer) => answer.kind === "fusion");
	const bestSolo = item.answers
		.filter((answer) => answer.kind === "single")
		.sort((a, b) => scoreFor(item, b) - scoreFor(item, a))[0];
	const delta = fusion && bestSolo ? scoreFor(item, fusion) - scoreFor(item, bestSolo) : 0;

	return `### ${index + 1}. ${item.case.title}\n\n- Winner: ${winner ? answerDisplay(winner) : item.judge.winner}\n- Fusion gain: ${item.judge.fusion_gain}\n- Fusion vs best solo: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} quality points\n- Judge: ${item.judgeModel}\n- Duration: ${formatDuration(item.durationMs)}\n\n| Answer | Kind | Quality | Correctness | Completeness | Time | Cost | Notes |\n|---|---|---:|---:|---:|---:|---:|---|\n${rows}\n\n**Why winner**\n${item.judge.why_winner || "No rationale provided."}\n\n**Fusion strengths**\n${bulletList(item.judge.fusion_strengths)}\n\n**Fusion weaknesses**\n${bulletList(item.judge.fusion_weaknesses)}\n\n_Expand this message to inspect the full solo answers, Fusion answer, and raw judge output._`;
}

export function formatComparativeBenchmarkResults(profile: string, config: FusionConfig, results: ComparativeBenchmarkCaseResult[]): string {
	const successful = results.filter((item) => !item.error);
	const totalDuration = results.reduce((sum, item) => sum + item.durationMs, 0);
	const totalCost = successful.reduce((sum, item) => sum + item.answers.reduce((inner, answer) => inner + comparativeAnswerCost(answer), 0), 0);
	const totalCallsPerCase = Math.max(2, config.panelModels.length) * 2 + 3;
	const caseDetails = results.map(formatComparativeCase).join("\n\n---\n\n");

	return `## Pi Fusion solo-vs-fusion benchmark (${profile})\n\nThis compares each configured panel model running solo against the synthesized Fusion answer. A blind judge scores anonymized outputs on a 1–10 rubric. This is still an LLM-as-judge signal, not a formal eval, but it directly measures whether combining models improved output quality.\n\n**Config**\n- Solo baselines: ${config.panelModels.join(", ")}\n- Fusion: ${config.panelModels.join(" + ")} → judge → final writer\n- Quality judge: ${config.judgeModel || "(auto)"}\n- Output caps: solo ${config.finalMaxTokens}, panel ${config.panelMaxTokens}, judge ${config.judgeMaxTokens}, final ${config.finalMaxTokens}\n- Panel/solo execution: ${config.panelExecution}\n- Estimated calls per case: ${totalCallsPerCase} (${Math.max(2, config.panelModels.length)} solo + ${Math.max(2, config.panelModels.length)} panel + Fusion judge/final + quality judge)\n\n**Summary**\n- Successful cases: ${successful.length}/${results.length}\n- Total duration: ${formatDuration(totalDuration)}\n- Estimated total API cost: ${formatCost(totalCost)}${config.panelExecution === "pi" ? " (excludes Pi child solo/panel usage)" : ""}\n\n**README-ready quality chart**\n\n\`\`\`text\n${formatComparativeChart(successful)}\n\`\`\`\n\n## Per-case comparison\n\n${caseDetails}`;
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

	pi.registerMessageRenderer<ComparativeBenchmarkMessageDetails>("pi-fusion-benchmark-compare", (message, options, theme) => {
		const base = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		const text = options.expanded && message.details ? `${base}${formatComparativeExpandedDetails(message.details)}` : base;
		const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
		try {
			box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		} catch {
			box.addChild(new Text(theme.fg("customMessageLabel", "pi-fusion benchmark compare") + "\n" + text, 0, 0));
		}
		return box;
	});
}
