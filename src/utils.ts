import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CandidateAnswer, FusionResult } from "./types.ts";

export function extractText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

export function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

export function extractJsonObject(text: string): unknown | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	return JSON.parse(candidate.slice(start, end + 1));
}

export function asStringList(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function normalizeStopReason(raw?: string): string {
	const value = raw?.toLowerCase().trim();
	if (!value) return "unknown";
	if (["length", "max_tokens", "max_output_tokens"].includes(value)) return "length";
	if (["stop", "end_turn", "stop_sequence"].includes(value)) return "stop";
	if (["content_filter", "safety", "blocked", "refusal"].includes(value)) return "blocked";
	if (["tool_use", "tooluse", "tool_calls"].includes(value)) return "toolUse";
	return value;
}

export function normalizeSectionText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_~#>:-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function hasRequiredSection(text: string, section: string): boolean {
	const target = normalizeSectionText(section);
	return text.split(/\r?\n/).some((line) => {
		const normalized = normalizeSectionText(line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, ""));
		return normalized === target || normalized.startsWith(`${target} `);
	});
}

export function findMissingRequiredSections(text: string, requiredSections: string[]): string[] {
	if (requiredSections.length === 0) return [];
	return requiredSections.filter((section) => !hasRequiredSection(text, section));
}

export function annotateCandidateCompleteness(candidates: CandidateAnswer[], requiredSections: string[]): CandidateAnswer[] {
	if (requiredSections.length === 0) return candidates;
	return candidates.map((candidate) => ({
		...candidate,
		missingRequiredSections: candidate.error ? [...requiredSections] : findMissingRequiredSections(candidate.text, requiredSections),
	}));
}

export function normalizeConfidence(value: unknown): number {
	let numeric: number;
	if (typeof value === "number") {
		numeric = value;
	} else if (typeof value === "string") {
		numeric = Number(value.trim().replace(/%$/, ""));
	} else {
		return 50;
	}

	if (!Number.isFinite(numeric)) return 50;
	// Some models return probability-style confidence (0.0-1.0) even when asked
	// for 0-100. Normalize that to a percentage for display and aggregation.
	if (numeric > 0 && numeric <= 1) numeric *= 100;
	return Math.max(0, Math.min(100, numeric));
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function estimatedCost(result: FusionResult): number {
	return [
		...result.panel.map((candidate) => candidate.usage?.cost.total ?? 0),
		result.judgeUsage?.cost.total ?? 0,
		result.finalUsage?.cost.total ?? 0,
	].reduce((sum, value) => sum + value, 0);
}

export function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "n/a";
	return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

export function tableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>");
}

export function bulletList(items: string[], fallback = "None reported."): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : fallback;
}

export function excerpt(text: string, maxChars = 900): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars).trimEnd()}\n\n…[truncated; expand the pi-fusion result or rerun single case with /fuse-* for full text]`;
}
