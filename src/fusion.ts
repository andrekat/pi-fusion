import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { choosePanelModels, chooseSingleModel, runCompletion } from "./models.ts";
import type { CandidateAnswer, FusionConfig, FusionMode, FusionResult, JudgeDecision, ResolvedModel } from "./types.ts";
import { annotateCandidateCompleteness, asStringList, entryToMessage, extractJsonObject, extractText, normalizeConfidence, normalizeStopReason } from "./utils.ts";

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

export function normalizeJudge(text: string): JudgeDecision {
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

export async function runFusion(
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
