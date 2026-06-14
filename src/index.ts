import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Api, type AssistantMessage, type Message, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, getAgentDir, getMarkdownTheme, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

type FusionMode = "general" | "plan" | "code" | "review";
type CodeStrategy = "parallel" | "propose-critique";
type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface FusionConfig {
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

interface ResolvedModel {
	ref: string;
	model: Model<Api>;
}

interface ModelCallOptions {
	maxTokens: number;
	temperature: number;
	reasoningEffort: ReasoningEffort;
}

interface CandidateAnswer {
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

interface JudgeDecision {
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

interface FusionResult {
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

interface BenchmarkCase {
	id: string;
	title: string;
	mode: FusionMode;
	prompt: string;
	requiredSections?: string[];
}

interface BenchmarkCaseResult {
	case: BenchmarkCase;
	result?: FusionResult;
	error?: string;
	durationMs: number;
}

interface BenchmarkMessageDetails {
	profile: string;
	results: BenchmarkCaseResult[];
}

const DEFAULT_CONFIG: FusionConfig = {
	panelModels: ["anthropic/claude-opus-4-8", "opencode/gpt-5.5-pro"],
	judgeModel: "opencode/gpt-5.5-pro",
	finalModel: "opencode/gpt-5.5-pro",
	includeConversation: true,
	conversationEntries: 12,
	maxContextChars: 24_000,
	panelMaxTokens: 4096,
	judgeMaxTokens: 2048,
	finalMaxTokens: 4096,
	panelTemperature: 0.2,
	judgeTemperature: 0,
	finalTemperature: 0.2,
	reasoningEffort: "high",
	showIntermediate: false,
	codeStrategy: "propose-critique",
};

const PREFERRED_FALLBACK_MODELS = [
	"anthropic/claude-opus-4-8",
	"opencode/gpt-5.5-pro",
	"opencode/gpt-5.2-pro",
	"openai/gpt-5.5-pro",
	"azure-openai-responses/gpt-5.5-pro",
	"openai/gpt-5.2-pro",
	"anthropic/claude-sonnet-4-5",
	"opencode/gpt-5.2",
	"openai/gpt-5.2",
];

const BENCHMARK_LIMITS = {
	quick: { panelMaxTokens: 2200, judgeMaxTokens: 900, finalMaxTokens: 1200, reasoningEffort: "low" as const },
	standard: { panelMaxTokens: 2200, judgeMaxTokens: 900, finalMaxTokens: 1200, reasoningEffort: "medium" as const },
	full: { panelMaxTokens: 2200, judgeMaxTokens: 900, finalMaxTokens: 1200, reasoningEffort: "medium" as const },
};

const BENCHMARK_CASES: BenchmarkCase[] = [
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

function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function configPath(): string {
	return join(getAgentDir(), "pi-fusion.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-fusion.json");
}

function readJsonFile(path: string): unknown | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, value));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const models = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
	return models.length > 0 ? models : fallback;
}

function normalizeConfig(input: unknown, base: FusionConfig = DEFAULT_CONFIG): FusionConfig {
	const raw = input && typeof input === "object" ? (input as Partial<FusionConfig>) : {};
	const reasoningEffort = ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(raw.reasoningEffort))
		? (raw.reasoningEffort as ReasoningEffort)
		: base.reasoningEffort;
	const codeStrategy = raw.codeStrategy === "parallel" || raw.codeStrategy === "propose-critique" ? raw.codeStrategy : base.codeStrategy;

	return {
		panelModels: asStringArray(raw.panelModels, base.panelModels),
		judgeModel: typeof raw.judgeModel === "string" && raw.judgeModel.trim() ? raw.judgeModel.trim() : base.judgeModel,
		finalModel: typeof raw.finalModel === "string" && raw.finalModel.trim() ? raw.finalModel.trim() : base.finalModel,
		includeConversation: asBoolean(raw.includeConversation, base.includeConversation),
		conversationEntries: Math.round(asNumber(raw.conversationEntries, base.conversationEntries, 0, 80)),
		maxContextChars: Math.round(asNumber(raw.maxContextChars, base.maxContextChars, 0, 200_000)),
		panelMaxTokens: Math.round(asNumber(raw.panelMaxTokens, base.panelMaxTokens, 512, 32_000)),
		judgeMaxTokens: Math.round(asNumber(raw.judgeMaxTokens, base.judgeMaxTokens, 512, 16_000)),
		finalMaxTokens: Math.round(asNumber(raw.finalMaxTokens, base.finalMaxTokens, 512, 32_000)),
		panelTemperature: asNumber(raw.panelTemperature, base.panelTemperature, 0, 2),
		judgeTemperature: asNumber(raw.judgeTemperature, base.judgeTemperature, 0, 2),
		finalTemperature: asNumber(raw.finalTemperature, base.finalTemperature, 0, 2),
		reasoningEffort,
		showIntermediate: asBoolean(raw.showIntermediate, base.showIntermediate),
		codeStrategy,
	};
}

function loadConfig(ctx: ExtensionContext): FusionConfig {
	let config = DEFAULT_CONFIG;
	try {
		config = normalizeConfig(readJsonFile(configPath()), config);
	} catch (error) {
		ctx.ui.notify(`pi-fusion: failed to read global config: ${String(error)}`, "warning");
	}

	try {
		const path = projectConfigPath(ctx.cwd);
		if (ctx.isProjectTrusted() && existsSync(path)) {
			config = normalizeConfig(readJsonFile(path), config);
		}
	} catch (error) {
		ctx.ui.notify(`pi-fusion: failed to read project config: ${String(error)}`, "warning");
	}

	return config;
}

function saveGlobalConfig(config: FusionConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

function resolveModel(ctx: ExtensionContext, ref: string): ResolvedModel | undefined {
	const parsed = parseModelRef(ref);
	if (parsed) {
		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		return model ? { ref: modelRef(model), model } : undefined;
	}

	const matches = ctx.modelRegistry.getAll().filter((model) => model.id === ref.trim());
	if (matches.length === 1) {
		return { ref: modelRef(matches[0]), model: matches[0] };
	}
	return undefined;
}

function uniqueResolved(models: Array<ResolvedModel | undefined>): ResolvedModel[] {
	const seen = new Set<string>();
	const result: ResolvedModel[] = [];
	for (const model of models) {
		if (!model || seen.has(model.ref)) continue;
		seen.add(model.ref);
		result.push(model);
	}
	return result;
}

function hasConfiguredAuth(ctx: ExtensionContext, model: Model<Api>): boolean {
	return ctx.modelRegistry.hasConfiguredAuth(model);
}

function findAuthenticatedEquivalent(ctx: ExtensionContext, model: Model<Api>): ResolvedModel | undefined {
	if (hasConfiguredAuth(ctx, model)) return { ref: modelRef(model), model };

	const sameId = ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === model.id);
	if (sameId) return { ref: modelRef(sameId), model: sameId };

	return undefined;
}

function resolveUsableModel(ctx: ExtensionContext, ref: string): ResolvedModel | undefined {
	const resolved = resolveModel(ctx, ref);
	if (resolved) return findAuthenticatedEquivalent(ctx, resolved.model);

	const parsed = parseModelRef(ref);
	if (parsed) {
		const sameId = ctx.modelRegistry.getAvailable().find((model) => model.id === parsed.modelId);
		if (sameId) return { ref: modelRef(sameId), model: sameId };
	}

	return undefined;
}

function choosePanelModels(ctx: ExtensionContext, config: FusionConfig): ResolvedModel[] {
	const configured = config.panelModels.map((ref) => resolveUsableModel(ctx, ref));
	const fallbackRefs = [
		...(ctx.model ? [modelRef(ctx.model)] : []),
		...PREFERRED_FALLBACK_MODELS,
		...ctx.modelRegistry.getAvailable().map(modelRef),
	];
	return uniqueResolved([...configured, ...fallbackRefs.map((ref) => resolveUsableModel(ctx, ref))]).slice(0, Math.max(2, config.panelModels.length));
}

function chooseSingleModel(ctx: ExtensionContext, preferredRef: string | undefined, fallbacks: ResolvedModel[]): ResolvedModel | undefined {
	return uniqueResolved([
		preferredRef ? resolveUsableModel(ctx, preferredRef) : undefined,
		...(ctx.model ? [resolveUsableModel(ctx, modelRef(ctx.model))] : []),
		...fallbacks,
		...PREFERRED_FALLBACK_MODELS.map((ref) => resolveUsableModel(ctx, ref)),
	])[0];
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
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

function getConversationContext(ctx: ExtensionCommandContext, config: FusionConfig): string {
	if (!config.includeConversation || config.conversationEntries <= 0 || config.maxContextChars <= 0) return "";
	const entries = ctx.sessionManager.getBranch();
	const recent = entries.slice(-config.conversationEntries);
	const messages = recent.map(entryToMessage).filter((message) => message !== undefined);
	if (messages.length === 0) return "";
	const text = serializeConversation(convertToLlm(messages));
	if (text.length <= config.maxContextChars) return text;
	return `...[conversation context truncated to last ${config.maxContextChars.toLocaleString()} chars]\n${text.slice(-config.maxContextChars)}`;
}

function buildTaskPrompt(prompt: string, contextText: string): string {
	if (!contextText.trim()) return `<task>\n${prompt}\n</task>`;
	return `<conversation_context>\n${contextText}\n</conversation_context>\n\n<task>\n${prompt}\n</task>`;
}

function modeGuidance(mode: FusionMode): string {
	switch (mode) {
		case "plan":
			return "Focus on architecture, trade-offs, sequencing, dependencies, and risks. Prefer a crisp implementation plan over generic advice.";
		case "code":
			return "Focus on code correctness, maintainability, edge cases, tests, and practical patch guidance. Do not claim you edited files.";
		case "review":
			return "Focus on review findings: correctness issues, regressions, missing tests, security/performance concerns, and what should be changed before merge.";
		case "general":
		default:
			return "Focus on correctness, completeness, simplicity, maintainability, risks, and concrete next steps.";
	}
}

function panelSystemPrompt(mode: FusionMode, label: string, modelRefValue: string, role: string): string {
	return `You are panelist ${label} (${modelRefValue}) in a Pi Fusion multi-model deliberation.\n\nYour role: ${role}.\n\n${modeGuidance(mode)}\n\nAnswer independently. Be specific. Surface assumptions and failure modes. If the prompt asks for code or a refactor, prefer actionable patch-level guidance and tests/checks. If the user requests a word limit or required sections, obey it strictly: finish all requested sections, using dense bullets if needed. Do not mention that other panelists exist.`;
}

function judgeSystemPrompt(mode: FusionMode): string {
	return `You are the Pi Fusion judge for a ${mode} task. Do not merely summarize. Do not solve from scratch unless every candidate answer is bad. Compare candidate answers on:\n1. Correctness\n2. Completeness\n3. Simplicity\n4. Maintainability\n5. Risks / edge cases\n6. Testability\n\nImportant: prefer "hybrid" when the best final answer should combine specific parts from multiple candidates. A candidate can be the overall winner while still requiring a crucial insight, caveat, or test from another candidate. Explicitly name what must be kept from each model so the final writer can synthesize instead of copying one answer wholesale.\n\nReturn ONLY valid JSON with this exact shape. confidence MUST be an integer from 0 to 100, where 100 means fully confident:\n{\n  "winner": "model_a | model_b | model_c | hybrid | neither",\n  "critical_issues": [],\n  "strongest_points_from_a": [],\n  "strongest_points_from_b": [],\n  "must_include_from_a": [],\n  "must_include_from_b": [],\n  "synthesis_plan": [],\n  "unique_insights": [],\n  "contradictions": [],\n  "recommended_final_answer": "",\n  "confidence": 85,\n  "tests_or_checks_needed": []\n}`;
}

function finalSystemPrompt(mode: FusionMode): string {
	return `You are the Pi Fusion final writer for a ${mode} task. Use the judge's evaluation and the best parts of the candidates to answer the user's task.\n\nRules:\n- Be decisive; do not just summarize the debate.\n- If the judge chose "hybrid" or lists must_include/synthesis_plan items, combine those parts deliberately. Do not copy one candidate wholesale when a better answer is A+B.\n- Preserve important caveats, risks, and tests/checks.\n- If there are contradictions, resolve them or call out uncertainty.\n- For code tasks, provide implementation-ready guidance, but do not claim files were modified.\n- Keep the final answer concise and useful.`;
}

function formatCandidates(candidates: CandidateAnswer[]): string {
	return candidates
		.map((candidate, index) => {
			const letter = String.fromCharCode(65 + index).toLowerCase();
			const status = candidate.error ? `ERROR: ${candidate.error}` : `Stop reason: ${candidate.stopReason || "unknown"}`;
			const completeness = candidate.missingRequiredSections
				? `\nCompleteness: ${candidate.missingRequiredSections.length === 0 ? "all required sections present" : `missing required sections: ${candidate.missingRequiredSections.join(", ")}`}`
				: "";
			return `## model_${letter}: ${candidate.modelRef}\nRole: ${candidate.role}\n${status}${completeness}\n\n${candidate.error ? "" : candidate.text}`;
		})
		.join("\n\n---\n\n");
}

function buildJudgePrompt(prompt: string, contextText: string, candidates: CandidateAnswer[]): string {
	return `${buildTaskPrompt(prompt, contextText)}\n\n<candidate_answers>\n${formatCandidates(candidates)}\n</candidate_answers>`;
}

function buildFinalPrompt(prompt: string, contextText: string, candidates: CandidateAnswer[], judgeRaw: string): string {
	return `${buildTaskPrompt(prompt, contextText)}\n\n<judge_evaluation>\n${judgeRaw}\n</judge_evaluation>\n\n<candidate_answers>\n${formatCandidates(candidates)}\n</candidate_answers>`;
}

function completionOptions(_model: Model<Api>, options: ModelCallOptions, signal: AbortSignal | undefined, apiKey?: string, headers?: Record<string, string>): Record<string, unknown> {
	const request: Record<string, unknown> = {
		apiKey,
		headers,
		signal,
		maxTokens: options.maxTokens,
	};
	// Do not send temperature from pi-fusion. Current flagship reasoning models
	// such as Claude Opus 4.8, GPT-5.5 Pro, and Codex reject it even when older
	// provider metadata says it might be supported. Provider defaults are fine.
	if (options.reasoningEffort !== "off") {
		request.reasoningEffort = options.reasoningEffort;
	}
	return request;
}

async function runCompletion(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	resolved: ResolvedModel,
	systemPrompt: string,
	userText: string,
	options: ModelCallOptions,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp: Date.now(),
	};

	const response = await complete(
		resolved.model,
		{ systemPrompt, messages: [userMessage] as Message[] },
		completionOptions(resolved.model, options, signal, auth.apiKey, auth.headers),
	);

	if (response.stopReason === "aborted") {
		throw new Error("aborted");
	}
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "model returned stopReason=error");
	}
	return response;
}

async function runCandidate(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	model: ResolvedModel,
	label: string,
	role: string,
	systemPrompt: string,
	userText: string,
	signal: AbortSignal | undefined,
): Promise<CandidateAnswer> {
	const started = Date.now();
	try {
		const response = await runCompletion(
			ctx,
			config,
			model,
			systemPrompt,
			userText,
			{
				maxTokens: config.panelMaxTokens,
				temperature: config.panelTemperature,
				reasoningEffort: config.reasoningEffort,
			},
			signal,
		);
		const text = extractText(response);
		if (!text) throw new Error("empty response");
		return {
			label,
			modelRef: model.ref,
			role,
			text,
			durationMs: Date.now() - started,
			stopReason: normalizeStopReason(response.stopReason),
			usage: response.usage,
		};
	} catch (error) {
		return {
			label,
			modelRef: model.ref,
			role,
			text: "",
			durationMs: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function runPanel(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	mode: FusionMode,
	models: ResolvedModel[],
	prompt: string,
	contextText: string,
	signal: AbortSignal | undefined,
): Promise<CandidateAnswer[]> {
	const taskPrompt = buildTaskPrompt(prompt, contextText);
	if (mode === "code" && config.codeStrategy === "propose-critique" && models.length >= 2) {
		const proposer = models[0];
		const proposerRole = "Primary implementation proposer";
		const first = await runCandidate(
			ctx,
			config,
			proposer,
			"A",
			proposerRole,
			panelSystemPrompt(mode, "A", proposer.ref, proposerRole),
			taskPrompt,
			signal,
		);

		const critiquePrompt = `${taskPrompt}\n\n<primary_proposal_from_model_a>\n${first.error ? `ERROR: ${first.error}` : first.text}\n</primary_proposal_from_model_a>\n\nCritique the primary proposal. Identify bugs, missing edge cases, simpler alternatives, tests/checks, and any parts worth keeping. If the proposal is fundamentally flawed, propose a better path.`;
		const critics = await Promise.all(
			models.slice(1).map((model, index) => {
				const label = String.fromCharCode(66 + index);
				const role = "Implementation critic and improvement proposer";
				return runCandidate(ctx, config, model, label, role, panelSystemPrompt(mode, label, model.ref, role), critiquePrompt, signal);
			}),
		);
		return [first, ...critics];
	}

	return Promise.all(
		models.map((model, index) => {
			const label = String.fromCharCode(65 + index);
			const role = mode === "review" ? "Independent reviewer" : mode === "plan" ? "Independent planner" : "Independent solver";
			return runCandidate(ctx, config, model, label, role, panelSystemPrompt(mode, label, model.ref, role), taskPrompt, signal);
		}),
	);
}

function extractJsonObject(text: string): unknown | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	return JSON.parse(candidate.slice(start, end + 1));
}

function asStringList(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeStopReason(raw?: string): string {
	const value = raw?.toLowerCase().trim();
	if (!value) return "unknown";
	if (["length", "max_tokens", "max_output_tokens"].includes(value)) return "length";
	if (["stop", "end_turn", "stop_sequence"].includes(value)) return "stop";
	if (["content_filter", "safety", "blocked", "refusal"].includes(value)) return "blocked";
	if (["tool_use", "tooluse", "tool_calls"].includes(value)) return "toolUse";
	return value;
}

function normalizeSectionText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_~#>:-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function hasRequiredSection(text: string, section: string): boolean {
	const target = normalizeSectionText(section);
	return text.split(/\r?\n/).some((line) => {
		const normalized = normalizeSectionText(line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, ""));
		return normalized === target || normalized.startsWith(`${target} `);
	});
}

function findMissingRequiredSections(text: string, requiredSections: string[]): string[] {
	if (requiredSections.length === 0) return [];
	return requiredSections.filter((section) => !hasRequiredSection(text, section));
}

function annotateCandidateCompleteness(candidates: CandidateAnswer[], requiredSections: string[]): CandidateAnswer[] {
	if (requiredSections.length === 0) return candidates;
	return candidates.map((candidate) => ({
		...candidate,
		missingRequiredSections: candidate.error ? [...requiredSections] : findMissingRequiredSections(candidate.text, requiredSections),
	}));
}

function normalizeConfidence(value: unknown): number {
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

function normalizeJudge(text: string): JudgeDecision {
	try {
		const raw = extractJsonObject(text) as Partial<JudgeDecision> | undefined;
		if (!raw || typeof raw !== "object") throw new Error("missing JSON object");
		return {
			winner: typeof raw.winner === "string" ? raw.winner : "hybrid",
			critical_issues: asStringList(raw.critical_issues),
			strongest_points_from_a: asStringList(raw.strongest_points_from_a),
			strongest_points_from_b: asStringList(raw.strongest_points_from_b),
			must_include_from_a: asStringList(raw.must_include_from_a),
			must_include_from_b: asStringList(raw.must_include_from_b),
			synthesis_plan: asStringList(raw.synthesis_plan),
			unique_insights: asStringList(raw.unique_insights),
			contradictions: asStringList(raw.contradictions),
			recommended_final_answer: typeof raw.recommended_final_answer === "string" ? raw.recommended_final_answer : "",
			confidence: normalizeConfidence(raw.confidence),
			tests_or_checks_needed: asStringList(raw.tests_or_checks_needed),
		};
	} catch {
		return {
			winner: "hybrid",
			critical_issues: ["Judge did not return parseable JSON; using raw judge text as guidance."],
			strongest_points_from_a: [],
			strongest_points_from_b: [],
			must_include_from_a: [],
			must_include_from_b: [],
			synthesis_plan: [],
			unique_insights: [],
			contradictions: [],
			recommended_final_answer: text,
			confidence: 50,
			tests_or_checks_needed: [],
		};
	}
}

async function runFusion(
	ctx: ExtensionCommandContext,
	config: FusionConfig,
	mode: FusionMode,
	prompt: string,
	signal: AbortSignal | undefined,
	requiredSections: string[] = [],
): Promise<FusionResult> {
	const started = Date.now();
	const panelModels = choosePanelModels(ctx, config);
	if (panelModels.length < 2) {
		throw new Error("Need at least two configured or available models. Run /fuse-settings and set panel models as provider/model.");
	}

	const judgeModel = chooseSingleModel(ctx, config.judgeModel, panelModels) ?? panelModels[0];
	const finalModel = chooseSingleModel(ctx, config.finalModel, [judgeModel, ...panelModels]) ?? judgeModel;
	const contextText = getConversationContext(ctx, config);

	const panel = annotateCandidateCompleteness(
		await runPanel(ctx, config, mode, panelModels, prompt, contextText, signal),
		requiredSections,
	);
	const successfulPanel = panel.filter((candidate) => candidate.text.trim() && !candidate.error);
	if (successfulPanel.length === 0) {
		throw new Error(`All panel models failed:\n${panel.map((candidate) => `- ${candidate.modelRef}: ${candidate.error || "empty"}`).join("\n")}`);
	}

	let judgeRaw = "";
	let judge: JudgeDecision;
	let judgeDurationMs: number | undefined;
	let judgeUsage: AssistantMessage["usage"] | undefined;
	try {
		const judgeStarted = Date.now();
		const judgeResponse = await runCompletion(
			ctx,
			config,
			judgeModel,
			judgeSystemPrompt(mode),
			buildJudgePrompt(prompt, contextText, panel),
			{
				maxTokens: config.judgeMaxTokens,
				temperature: config.judgeTemperature,
				reasoningEffort: config.reasoningEffort,
			},
			signal,
		);
		judgeDurationMs = Date.now() - judgeStarted;
		judgeUsage = judgeResponse.usage;
		judgeRaw = extractText(judgeResponse);
		judge = normalizeJudge(judgeRaw);
	} catch (error) {
		judgeRaw = `Judge failed: ${error instanceof Error ? error.message : String(error)}`;
		judge = normalizeJudge(judgeRaw);
	}

	let finalAnswer = "";
	let finalDurationMs: number | undefined;
	let finalUsage: AssistantMessage["usage"] | undefined;
	try {
		const finalStarted = Date.now();
		const finalResponse = await runCompletion(
			ctx,
			config,
			finalModel,
			finalSystemPrompt(mode),
			buildFinalPrompt(prompt, contextText, panel, judgeRaw),
			{
				maxTokens: config.finalMaxTokens,
				temperature: config.finalTemperature,
				reasoningEffort: config.reasoningEffort,
			},
			signal,
		);
		finalDurationMs = Date.now() - finalStarted;
		finalUsage = finalResponse.usage;
		finalAnswer = extractText(finalResponse);
	} catch (error) {
		finalAnswer = judge.recommended_final_answer || successfulPanel[0]?.text || `Final writer failed: ${String(error)}`;
	}

	return {
		mode,
		prompt,
		panel,
		judgeModel: judgeModel.ref,
		finalModel: finalModel.ref,
		judgeRaw,
		judge,
		finalAnswer: finalAnswer.trim() || judge.recommended_final_answer || successfulPanel[0]?.text || "No final answer produced.",
		durationMs: Date.now() - started,
		contextIncluded: Boolean(contextText.trim()),
		judgeDurationMs,
		finalDurationMs,
		judgeUsage,
		finalUsage,
	};
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function estimatedCost(result: FusionResult): number {
	return [
		...result.panel.map((candidate) => candidate.usage?.cost.total ?? 0),
		result.judgeUsage?.cost.total ?? 0,
		result.finalUsage?.cost.total ?? 0,
	].reduce((sum, value) => sum + value, 0);
}

function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "n/a";
	return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

function formatFusionMessage(result: FusionResult, showIntermediate: boolean): string {
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

function detailsMarkdown(result: FusionResult): string {
	const candidates = result.panel
		.map((candidate) => `### ${candidate.label}: ${candidate.modelRef}\n\n${candidate.error ? `Error: ${candidate.error}` : candidate.text}`)
		.join("\n\n---\n\n");
	return `\n\n---\n\n## Expanded Fusion Details\n\n### Judge\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\n### Raw Judge Output\n\n\`\`\`\n${result.judgeRaw}\n\`\`\`\n\n## Candidate Answers\n\n${candidates}`;
}

function fusionOverviewMarkdown(result: FusionResult): string {
	const panel = result.panel
		.map((candidate) => `- ${candidate.label}: ${candidate.modelRef} — ${candidate.error ? `failed: ${candidate.error}` : `ok, ${formatDuration(candidate.durationMs)}${candidate.stopReason ? `, stop:${candidate.stopReason}` : ""}`}`)
		.join("\n");
	return `# Pi Fusion overview\n\n- Mode: ${result.mode}\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n- Judge: ${result.judgeModel}${result.judgeDurationMs ? ` (${formatDuration(result.judgeDurationMs)})` : ""}\n- Final writer: ${result.finalModel}${result.finalDurationMs ? ` (${formatDuration(result.finalDurationMs)})` : ""}\n- Duration: ${formatDuration(result.durationMs)}\n- Estimated API cost: ${formatCost(estimatedCost(result))}\n\n## Panel\n${panel}\n\n## Final synthesis\n\n${result.finalAnswer}`;
}

function fusionWinnerMarkdown(result: FusionResult): string {
	return `# Winner / synthesis\n\n- Winner: ${result.judge.winner}\n- Confidence: ${Math.round(result.judge.confidence)}%\n\n## Critical issues / caveats\n${bulletList(result.judge.critical_issues)}\n\n## Must include from A\n${bulletList(result.judge.must_include_from_a)}\n\n## Must include from B\n${bulletList(result.judge.must_include_from_b)}\n\n## Hybrid synthesis plan\n${bulletList(result.judge.synthesis_plan)}\n\n## Unique insights\n${bulletList(result.judge.unique_insights)}\n\n## Contradictions\n${bulletList(result.judge.contradictions)}\n\n## Tests/checks\n${bulletList(result.judge.tests_or_checks_needed)}`;
}

function fusionCandidatesMarkdown(result: FusionResult): string {
	return result.panel
		.map((candidate) => `# Candidate ${candidate.label}: ${candidate.modelRef}\n\n- Role: ${candidate.role}\n- Status: ${candidate.error ? `failed: ${candidate.error}` : "ok"}\n- Duration: ${formatDuration(candidate.durationMs)}\n${candidate.stopReason ? `- Stop reason: ${candidate.stopReason}\n` : ""}\n${candidate.error ? "" : candidate.text}`)
		.join("\n\n---\n\n");
}

function fusionRawMarkdown(result: FusionResult): string {
	return `# Raw judge artifacts\n\n## Parsed judge JSON\n\n\`\`\`json\n${JSON.stringify(result.judge, null, 2)}\n\`\`\`\n\n## Raw judge output\n\n\`\`\`\n${result.judgeRaw}\n\`\`\``;
}

function findLastFusionResult(ctx: ExtensionCommandContext): FusionResult | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as SessionEntry & {
			customType?: string;
			details?: unknown;
			message?: { role?: string; customType?: string; details?: unknown };
		};

		// pi.sendMessage() is stored as a custom_message entry in current Pi sessions.
		if (entry.type === "custom_message" && entry.customType === "pi-fusion" && entry.details) {
			return entry.details as FusionResult;
		}

		// Keep compatibility with session/message formats that represent custom
		// extension messages as AgentMessage role=custom.
		if (entry.type === "message" && entry.message?.role === "custom" && entry.message.customType === "pi-fusion" && entry.message.details) {
			return entry.message.details as FusionResult;
		}
	}
	return undefined;
}

async function showFusionViewer(ctx: ExtensionCommandContext, result: FusionResult): Promise<void> {
	const tabs = ["Overview", "Winner", "Final", "Candidates", "Raw"] as const;
	type Tab = (typeof tabs)[number];
	let selected = 0;
	let scrollOffset = 0;
	let lastMaxScroll = 0;
	let lastViewportRows = 12;

	function tabMarkdown(tab: Tab): string {
		switch (tab) {
			case "Winner":
				return fusionWinnerMarkdown(result);
			case "Final":
				return `# Final synthesis\n\n${result.finalAnswer}`;
			case "Candidates":
				return fusionCandidatesMarkdown(result);
			case "Raw":
				return fusionRawMarkdown(result);
			case "Overview":
			default:
				return fusionOverviewMarkdown(result);
		}
	}

	function clampScroll(): void {
		scrollOffset = Math.max(0, Math.min(scrollOffset, lastMaxScroll));
	}

	function switchTab(next: number): void {
		selected = (next + tabs.length) % tabs.length;
		scrollOffset = 0;
		tuiRequestRender?.();
	}

	let tuiRequestRender: (() => void) | undefined;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		tuiRequestRender = () => tui.requestRender();
		return {
			render(width: number) {
				const innerWidth = Math.max(20, width - 4);
				const bodyLines = new Markdown(tabMarkdown(tabs[selected]), 0, 0, getMarkdownTheme()).render(innerWidth);
				lastViewportRows = Math.max(8, Math.floor(tui.terminal.rows * 0.82) - 5);
				lastMaxScroll = Math.max(0, bodyLines.length - lastViewportRows);
				clampScroll();
				const visibleLines = bodyLines.slice(scrollOffset, scrollOffset + lastViewportRows);
				const endRow = Math.min(bodyLines.length, scrollOffset + visibleLines.length);
				const scrollInfo = bodyLines.length > lastViewportRows
					? `scroll ${scrollOffset + 1}-${endRow}/${bodyLines.length}`
					: `${bodyLines.length} lines`;

				const container = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
				const tabLine = tabs
					.map((tab, index) => {
						const label = `${index + 1}:${tab}`;
						return index === selected ? theme.bg("selectedBg", theme.fg("accent", ` ${label} `)) : theme.fg("muted", ` ${label} `);
					})
					.join(" ");
				const body = new Container();
				body.addChild(new Text(`${theme.fg("accent", theme.bold("Pi Fusion viewer"))}  ${tabLine}`, 0, 0));
				body.addChild(new Text(theme.fg("dim", `←/→ tabs • ↑/↓ scroll • pgup/pgdn page • 1-5 jump • enter/esc/q close • ${scrollInfo}`), 0, 0));
				body.addChild({
					render: () => visibleLines,
					invalidate() {},
				});
				container.addChild(body);
				return container.render(width);
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.left) || data === "h") {
					switchTab(selected - 1);
					return;
				}
				if (matchesKey(data, Key.right) || data === "l" || matchesKey(data, Key.tab)) {
					switchTab(selected + 1);
					return;
				}
				if (matchesKey(data, Key.up) || data === "k") {
					scrollOffset -= 1;
					clampScroll();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down) || data === "j") {
					scrollOffset += 1;
					clampScroll();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.pageUp)) {
					scrollOffset -= Math.max(1, lastViewportRows - 2);
					clampScroll();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.pageDown) || data === " ") {
					scrollOffset += Math.max(1, lastViewportRows - 2);
					clampScroll();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.home) || data === "g") {
					scrollOffset = 0;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.end) || data === "G") {
					scrollOffset = lastMaxScroll;
					tui.requestRender();
					return;
				}
				const numeric = Number(data);
				if (Number.isInteger(numeric) && numeric >= 1 && numeric <= tabs.length) {
					switchTab(numeric - 1);
				}
			},
		};
	}, { overlay: true, overlayOptions: { width: "92%", maxHeight: "88%", anchor: "center", margin: 1 } });
}

async function runFusionCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, mode: FusionMode, args: string): Promise<void> {
	const prompt = args.trim();
	if (!prompt) {
		ctx.ui.notify(`Usage: /${mode === "general" ? "fuse" : `fuse-${mode}`} <prompt>`, "warning");
		return;
	}

	const config = loadConfig(ctx);
	const execute = (signal?: AbortSignal) => runFusion(ctx, config, mode, prompt, signal);

	let result: FusionResult | null = null;
	if (ctx.mode === "tui") {
		result = await ctx.ui.custom<FusionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Fusing ${config.panelModels.length} panel model(s) for /${mode === "general" ? "fuse" : `fuse-${mode}`}...`);
			loader.onAbort = () => done(null);
			execute(loader.signal)
				.then(done)
				.catch((error) => {
					ctx.ui.notify(`pi-fusion failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					done(null);
				});
			return loader;
		});
	} else {
		result = await execute(undefined);
	}

	if (!result) {
		ctx.ui.notify("pi-fusion cancelled", "info");
		return;
	}

	const content = formatFusionMessage(result, config.showIntermediate);
	pi.sendMessage<FusionResult>({ customType: "pi-fusion", content, display: true, details: result });
}

function benchmarkConfig(config: FusionConfig, profile: string): FusionConfig {
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

function benchmarkCasesForProfile(profile: string): BenchmarkCase[] {
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

function benchmarkCallCount(config: FusionConfig, cases: BenchmarkCase[]): number {
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

function tableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>");
}

function bulletList(items: string[], fallback = "None reported."): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : fallback;
}

function excerpt(text: string, maxChars = 900): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars).trimEnd()}\n\n…[truncated; expand the pi-fusion result or rerun single case with /fuse-* for full text]`;
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

function formatBenchmarkExpandedDetails(details: BenchmarkMessageDetails): string {
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

function formatBenchmarkResults(profile: string, config: FusionConfig, results: BenchmarkCaseResult[]): string {
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

async function runBenchmarkCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
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

function configSummary(config: FusionConfig): string {
	return [
		`Panel models:\n${config.panelModels.map((model) => `  - ${model}`).join("\n")}`,
		`Judge model: ${config.judgeModel || "(auto)"}`,
		`Final model: ${config.finalModel || "(auto)"}`,
		`Include conversation: ${config.includeConversation ? "yes" : "no"}`,
		`Conversation entries: ${config.conversationEntries}`,
		`Max context chars: ${config.maxContextChars}`,
		`Reasoning effort: ${config.reasoningEffort}`,
		`Code strategy: ${config.codeStrategy}`,
		`Show intermediate: ${config.showIntermediate ? "yes" : "no"}`,
	].join("\n");
}

async function editNumber(ctx: ExtensionCommandContext, title: string, current: number): Promise<number | undefined> {
	const value = await ctx.ui.input(title, String(current));
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed)) {
		ctx.ui.notify("Not a valid number", "warning");
		return undefined;
	}
	return parsed;
}

async function chooseModelRef(ctx: ExtensionCommandContext, title: string, current: string | undefined): Promise<string | undefined> {
	const query = await ctx.ui.input(`${title}: type a filter or provider/model`, current || "");
	if (query === undefined) return undefined;
	const trimmed = query.trim();
	if (!trimmed) return "";

	const exact = resolveModel(ctx, trimmed);
	if (exact) return exact.ref;
	if (parseModelRef(trimmed)) return trimmed;

	const lower = trimmed.toLowerCase();
	const availableRefs = ctx.modelRegistry.getAvailable().map(modelRef);
	const allRefs = ctx.modelRegistry.getAll().map(modelRef);
	const refs = Array.from(new Set([...availableRefs, ...allRefs]))
		.filter((ref) => ref.toLowerCase().includes(lower))
		.slice(0, 40);

	if (refs.length === 0) {
		ctx.ui.notify(`No model matched "${trimmed}"`, "warning");
		return undefined;
	}

	const selected = await ctx.ui.select(title, [...refs, `Use "${trimmed}" as typed`, "Cancel"]);
	if (!selected || selected === "Cancel") return undefined;
	if (selected.startsWith("Use ")) return trimmed;
	return selected;
}

async function openSettings(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(configSummary(loadConfig(ctx)), "info");
		return;
	}

	let config = loadConfig(ctx);
	let dirty = false;
	while (true) {
		const action = await ctx.ui.select("pi-fusion settings", [
			"Edit panel models",
			"Set judge model",
			"Set final model",
			`Toggle conversation context (${config.includeConversation ? "on" : "off"})`,
			"Set context entry count",
			"Set max context chars",
			"Set reasoning effort",
			"Set code strategy",
			`Toggle intermediate output (${config.showIntermediate ? "on" : "off"})`,
			"Show current config",
			"Reset defaults",
			"Save and close",
			"Close without saving",
		]);

		if (!action || action === "Close without saving") return;
		if (action === "Save and close") break;

		if (action === "Edit panel models") {
			const edited = await ctx.ui.editor("Panel models (one provider/model per line)", config.panelModels.join("\n"));
			if (edited !== undefined) {
				const panelModels = edited.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
				if (panelModels.length < 2) {
					ctx.ui.notify("Please configure at least two panel models", "warning");
				} else {
					config = { ...config, panelModels };
					dirty = true;
				}
			}
		} else if (action === "Set judge model") {
			const value = await chooseModelRef(ctx, "Judge model", config.judgeModel);
			if (value !== undefined) {
				config = { ...config, judgeModel: value || undefined };
				dirty = true;
			}
		} else if (action === "Set final model") {
			const value = await chooseModelRef(ctx, "Final writer model", config.finalModel);
			if (value !== undefined) {
				config = { ...config, finalModel: value || undefined };
				dirty = true;
			}
		} else if (action.startsWith("Toggle conversation")) {
			config = { ...config, includeConversation: !config.includeConversation };
			dirty = true;
		} else if (action === "Set context entry count") {
			const value = await editNumber(ctx, "Conversation entries to include", config.conversationEntries);
			if (value !== undefined) {
				config = normalizeConfig({ ...config, conversationEntries: value });
				dirty = true;
			}
		} else if (action === "Set max context chars") {
			const value = await editNumber(ctx, "Max conversation context chars", config.maxContextChars);
			if (value !== undefined) {
				config = normalizeConfig({ ...config, maxContextChars: value });
				dirty = true;
			}
		} else if (action === "Set reasoning effort") {
			const value = await ctx.ui.select("Reasoning effort", ["off", "minimal", "low", "medium", "high", "xhigh"]);
			if (value) {
				config = { ...config, reasoningEffort: value as ReasoningEffort };
				dirty = true;
			}
		} else if (action === "Set code strategy") {
			const value = await ctx.ui.select("/fuse-code strategy", ["propose-critique", "parallel"]);
			if (value) {
				config = { ...config, codeStrategy: value as CodeStrategy };
				dirty = true;
			}
		} else if (action.startsWith("Toggle intermediate")) {
			config = { ...config, showIntermediate: !config.showIntermediate };
			dirty = true;
		} else if (action === "Show current config") {
			await ctx.ui.editor("Current pi-fusion config", configSummary(config));
		} else if (action === "Reset defaults") {
			const ok = await ctx.ui.confirm("Reset pi-fusion?", "Replace settings with defaults?");
			if (ok) {
				config = DEFAULT_CONFIG;
				dirty = true;
			}
		}
	}

	if (dirty) {
		saveGlobalConfig(config);
		ctx.ui.notify(`pi-fusion settings saved to ${configPath()}`, "info");
	} else {
		ctx.ui.notify("No pi-fusion settings changed", "info");
	}
}

function updateStatus(ctx: ExtensionContext): void {
	const config = loadConfig(ctx);
	ctx.ui.setStatus("pi-fusion", ctx.ui.theme.fg("accent", `fusion:${config.panelModels.length}`));
}

export default function piFusion(pi: ExtensionAPI) {
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

	pi.registerCommand("fuse", {
		description: "Run a prompt through multiple models, judge, and synthesize the best answer",
		handler: async (args, ctx) => runFusionCommand(pi, ctx, "general", args),
	});

	pi.registerCommand("fuse-plan", {
		description: "Fusion mode for architecture and implementation planning",
		handler: async (args, ctx) => runFusionCommand(pi, ctx, "plan", args),
	});

	pi.registerCommand("fuse-code", {
		description: "Fusion mode for code generation/refactor strategy and critique",
		handler: async (args, ctx) => runFusionCommand(pi, ctx, "code", args),
	});

	pi.registerCommand("fuse-review", {
		description: "Fusion mode for diff/PR/bugfix review",
		handler: async (args, ctx) => runFusionCommand(pi, ctx, "review", args),
	});

	pi.registerCommand("fuse-bench", {
		description: "Run bounded real-provider benchmarks: /fuse-bench [dry|quick|standard|full]",
		handler: async (args, ctx) => runBenchmarkCommand(pi, ctx, args),
	});

	pi.registerCommand("fuse-view", {
		description: "Open the last Pi Fusion answer in a tabbed TUI viewer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/fuse-view requires interactive TUI mode", "warning");
				return;
			}
			const result = findLastFusionResult(ctx);
			if (!result) {
				ctx.ui.notify("No Pi Fusion result found in this conversation", "warning");
				return;
			}
			await showFusionViewer(ctx, result);
		},
	});

	pi.registerCommand("fuse-settings", {
		description: "Configure pi-fusion panel, judge, final writer, and context settings",
		handler: async (_args, ctx) => {
			await openSettings(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("fuse-status", {
		description: "Show current pi-fusion configuration",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx);
			if (ctx.mode === "tui") {
				await ctx.ui.editor("pi-fusion status", configSummary(config));
			} else {
				ctx.ui.notify(configSummary(config), "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});
}
