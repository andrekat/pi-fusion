import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export type FusionMode = "general" | "plan" | "code" | "review";
export type CodeStrategy = "parallel" | "propose-critique";
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface FusionConfig {
	panelModels: string[];
	judgeModel?: string;
	finalModel?: string;
	includeConversation: boolean;
	conversationEntries: number;
	maxContextChars: number;
	panelMaxTokens: number;
	judgeMaxTokens: number;
	finalMaxTokens: number;
	panelTemperature: number;
	judgeTemperature: number;
	finalTemperature: number;
	reasoningEffort: ReasoningEffort;
	showIntermediate: boolean;
	codeStrategy: CodeStrategy;
}

export interface ResolvedModel {
	ref: string;
	model: Model<Api>;
}

export interface ModelCallOptions {
	maxTokens: number;
	temperature: number;
	reasoningEffort: ReasoningEffort;
}

export interface CandidateAnswer {
	label: string;
	modelRef: string;
	role: string;
	text: string;
	durationMs: number;
	stopReason?: string;
	missingRequiredSections?: string[];
	usage?: AssistantMessage["usage"];
	error?: string;
}

export interface JudgeDecision {
	winner: string;
	critical_issues: string[];
	strongest_points_from_a: string[];
	strongest_points_from_b: string[];
	must_include_from_a: string[];
	must_include_from_b: string[];
	synthesis_plan: string[];
	unique_insights: string[];
	contradictions: string[];
	recommended_final_answer: string;
	confidence: number;
	tests_or_checks_needed: string[];
}

export interface FusionResult {
	mode: FusionMode;
	prompt: string;
	panel: CandidateAnswer[];
	judgeModel: string;
	finalModel: string;
	judgeRaw: string;
	judge: JudgeDecision;
	finalAnswer: string;
	durationMs: number;
	contextIncluded: boolean;
	judgeDurationMs?: number;
	finalDurationMs?: number;
	judgeUsage?: AssistantMessage["usage"];
	finalUsage?: AssistantMessage["usage"];
}

export interface BenchmarkCase {
	id: string;
	title: string;
	mode: FusionMode;
	prompt: string;
	requiredSections?: string[];
}

export interface BenchmarkCaseResult {
	case: BenchmarkCase;
	result?: FusionResult;
	error?: string;
	durationMs: number;
}

export interface BenchmarkMessageDetails {
	profile: string;
	results: BenchmarkCaseResult[];
}
