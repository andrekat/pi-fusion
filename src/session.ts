import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FusionResult } from "./types.ts";

export function findLastFusionResult(ctx: ExtensionCommandContext): FusionResult | undefined {
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

export function sendFusionResult(pi: ExtensionAPI, content: string, result: FusionResult): void {
	pi.sendMessage<FusionResult>({ customType: "pi-fusion", content, display: true, details: result });
}
