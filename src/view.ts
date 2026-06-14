import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { fusionCandidatesMarkdown, fusionOverviewMarkdown, fusionRawMarkdown, fusionWinnerMarkdown } from "./render.ts";
import type { FusionResult } from "./types.ts";

export async function showFusionViewer(ctx: ExtensionCommandContext, result: FusionResult): Promise<void> {
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
