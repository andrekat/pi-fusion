import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { registerMessageRenderers } from "./render.ts";

export default function piFusion(pi: ExtensionAPI) {
	registerMessageRenderers(pi);
	registerCommands(pi);
}
