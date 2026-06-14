import { complete, type Api, type AssistantMessage, type Message, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PREFERRED_FALLBACK_MODELS } from "./config.ts";
import type { FusionConfig, ModelCallOptions, ResolvedModel } from "./types.ts";

export function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function resolveModel(ctx: ExtensionContext, ref: string): ResolvedModel | undefined {
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

export function resolveUsableModel(ctx: ExtensionContext, ref: string): ResolvedModel | undefined {
	const resolved = resolveModel(ctx, ref);
	if (resolved) return findAuthenticatedEquivalent(ctx, resolved.model);

	const parsed = parseModelRef(ref);
	if (parsed) {
		const sameId = ctx.modelRegistry.getAvailable().find((model) => model.id === parsed.modelId);
		if (sameId) return { ref: modelRef(sameId), model: sameId };
	}

	return undefined;
}

export function choosePanelModels(ctx: ExtensionContext, config: FusionConfig): ResolvedModel[] {
	const configured = config.panelModels.map((ref) => resolveUsableModel(ctx, ref));
	const fallbackRefs = [
		...(ctx.model ? [modelRef(ctx.model)] : []),
		...PREFERRED_FALLBACK_MODELS,
		...ctx.modelRegistry.getAvailable().map(modelRef),
	];
	return uniqueResolved([...configured, ...fallbackRefs.map((ref) => resolveUsableModel(ctx, ref))]).slice(0, Math.max(2, config.panelModels.length));
}

export function chooseSingleModel(ctx: ExtensionContext, preferredRef: string | undefined, fallbacks: ResolvedModel[]): ResolvedModel | undefined {
	return uniqueResolved([
		preferredRef ? resolveUsableModel(ctx, preferredRef) : undefined,
		...(ctx.model ? [resolveUsableModel(ctx, modelRef(ctx.model))] : []),
		...fallbacks,
		...PREFERRED_FALLBACK_MODELS.map((ref) => resolveUsableModel(ctx, ref)),
	])[0];
}

export function completionOptions(_model: Model<Api>, options: ModelCallOptions, signal: AbortSignal | undefined, apiKey?: string, headers?: Record<string, string>): Record<string, unknown> {
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

export async function runCompletion(
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
