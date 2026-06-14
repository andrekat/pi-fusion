import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { runBenchmarkCommand, runComparativeBenchmarkCommand } from "./benchmark.ts";
import { configPath, configSummary, DEFAULT_CONFIG, loadConfig, normalizeConfig, saveGlobalConfig } from "./config.ts";
import { runFusion } from "./fusion.ts";
import { modelRef, parseModelRef, resolveModel } from "./models.ts";
import { formatFusionMessage } from "./render.ts";
import { findLastFusionResult, sendFusionResult } from "./session.ts";
import type { CodeStrategy, FusionMode, FusionResult, ReasoningEffort } from "./types.ts";
import { showFusionViewer } from "./view.ts";

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
	sendFusionResult(pi, content, result);
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
			"Set panel execution",
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
		} else if (action === "Set panel execution") {
			const value = await ctx.ui.select("Panel execution", ["pi", "completion"]);
			if (value) {
				config = { ...config, panelExecution: value as "pi" | "completion" };
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

export function updateStatus(ctx: ExtensionContext): void {
	const config = loadConfig(ctx);
	ctx.ui.setStatus("pi-fusion", ctx.ui.theme.fg("accent", `fusion:${config.panelModels.length}`));
}

export function registerCommands(pi: ExtensionAPI): void {
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
		description: "Run bounded benchmarks: /fuse-bench [dry|quick|standard|full|compare quick]",
		handler: async (args, ctx) => runBenchmarkCommand(pi, ctx, args),
	});

	pi.registerCommand("fuse-bench-compare", {
		description: "Compare solo panel-model answers against Fusion: /fuse-bench-compare [dry|quick|standard|full]",
		handler: async (args, ctx) => runComparativeBenchmarkCommand(pi, ctx, args),
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
