import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FusionConfig, ReasoningEffort } from "./types.ts";

export const DEFAULT_CONFIG: FusionConfig = {
	panelModels: ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"],
	judgeModel: "openai-codex/gpt-5.5",
	finalModel: "openai-codex/gpt-5.5",
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
	panelExecution: "pi",
	showIntermediate: false,
	codeStrategy: "propose-critique",
};

export const PREFERRED_FALLBACK_MODELS = [
	"anthropic/claude-opus-4-8",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.4",
	"anthropic/claude-sonnet-4-5",
	"openai-codex/gpt-5.3-codex-spark",
	"openai/gpt-5.5",
	"openai/gpt-5.2",
];

export function configPath(): string {
	return join(getAgentDir(), "pi-fusion.json");
}

export function projectConfigPath(cwd: string): string {
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

export function normalizeConfig(input: unknown, base: FusionConfig = DEFAULT_CONFIG): FusionConfig {
	const raw = input && typeof input === "object" ? (input as Partial<FusionConfig>) : {};
	const reasoningEffort = ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(raw.reasoningEffort))
		? (raw.reasoningEffort as ReasoningEffort)
		: base.reasoningEffort;
	const codeStrategy = raw.codeStrategy === "parallel" || raw.codeStrategy === "propose-critique" ? raw.codeStrategy : base.codeStrategy;
	const panelExecution = raw.panelExecution === "completion" || raw.panelExecution === "pi" ? raw.panelExecution : base.panelExecution;

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
		panelExecution,
		showIntermediate: asBoolean(raw.showIntermediate, base.showIntermediate),
		codeStrategy,
	};
}

export function loadConfig(ctx: ExtensionContext): FusionConfig {
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

export function saveGlobalConfig(config: FusionConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

export function configSummary(config: FusionConfig): string {
	return [
		`Panel models:\n${config.panelModels.map((model) => `  - ${model}`).join("\n")}`,
		`Judge model: ${config.judgeModel || "(auto)"}`,
		`Final model: ${config.finalModel || "(auto)"}`,
		`Include conversation: ${config.includeConversation ? "yes" : "no"}`,
		`Conversation entries: ${config.conversationEntries}`,
		`Max context chars: ${config.maxContextChars}`,
		`Reasoning effort: ${config.reasoningEffort}`,
		`Panel execution: ${config.panelExecution}`,
		`Code strategy: ${config.codeStrategy}`,
		`Show intermediate: ${config.showIntermediate ? "yes" : "no"}`,
	].join("\n");
}
