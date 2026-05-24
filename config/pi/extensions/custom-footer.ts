import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, branch: string | null, sessionName?: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  let text = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (branch) text += ` (${branch})`;
  if (sessionName) text += ` — ${sessionName}`;
  return text;
}

export default function customFooter(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const installFooter = () => {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsubscribeBranch,
          invalidate() {},
          render(width: number): string[] {
            const branch = footerData.getGitBranch();
            const sessionName = ctx.sessionManager.getSessionName();
            const pwd = formatCwd(ctx.cwd, branch, sessionName);
            const extensionStatuses = footerData.getExtensionStatuses();
            const subscriptionStatusText = sanitizeStatusText(
              extensionStatuses.get("sub-status:usage") ?? extensionStatuses.get("sub-bar") ?? ""
            );
            const subscriptionStatus = subscriptionStatusText ? theme.fg("dim", subscriptionStatusText) : "";
            const fastStatus = sanitizeStatusText(extensionStatuses.get("pi-openai-fast") ?? "");
            const otherStatusEntries = Array.from(extensionStatuses.entries())
              .filter(([key]) =>
                key !== "sub-status:usage" &&
                key !== "sub-bar" &&
                key !== "pi-openai-fast" &&
                !key.startsWith("@marckrenn/pi-sub")
              )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, text]) => [key, sanitizeStatusText(text)] as const)
              .filter(([, text]) => Boolean(text));
            const locationStatuses = otherStatusEntries
              .filter(([key]) => key === "ssh")
              .map(([, text]) => text);
            const inlineStatuses = otherStatusEntries
              .filter(([key]) => key !== "ssh")
              .map(([, text]) => text);

            const dimPwd = theme.fg("dim", pwd);
            const leftParts = locationStatuses.length > 0 ? locationStatuses : [dimPwd];
            leftParts.push(...inlineStatuses);
            const leftBase = leftParts.join(" | ");
            let pwdLine: string;
            if (subscriptionStatus) {
              const gap = 2;
              const rightWidth = visibleWidth(subscriptionStatus);
              const leftWidth = Math.max(0, width - rightWidth - gap);
              if (leftWidth >= 8) {
                const left = truncateToWidth(leftBase, leftWidth, theme.fg("dim", "..."));
                const pad = " ".repeat(Math.max(gap, width - visibleWidth(left) - rightWidth));
                pwdLine = left + pad + subscriptionStatus;
              } else {
                pwdLine = truncateToWidth(subscriptionStatus, width, theme.fg("dim", "..."));
              }
            } else {
              pwdLine = truncateToWidth(leftBase, width, theme.fg("dim", "..."));
            }

            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheWrite = 0;
            let totalCost = 0;
            for (const entry of ctx.sessionManager.getEntries()) {
              const msg = (entry as any).message;
              if ((entry as any).type === "message" && msg?.role === "assistant" && msg.usage) {
                totalInput += msg.usage.input ?? 0;
                totalOutput += msg.usage.output ?? 0;
                totalCacheRead += msg.usage.cacheRead ?? 0;
                totalCacheWrite += msg.usage.cacheWrite ?? 0;
                totalCost += msg.usage.cost?.total ?? 0;
              }
            }

            const statsParts: string[] = [];
            if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
            if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
            if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
            if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

            const model = ctx.model;
            const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
            if (totalCost || usingSubscription) {
              statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
            }

            const contextUsage = ctx.getContextUsage?.();
            const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
            const contextPercentValue = contextUsage?.percent ?? 0;
            const contextDisplay = contextUsage?.percent === null
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
            const contextText = contextPercentValue > 90
              ? theme.fg("error", contextDisplay)
              : contextPercentValue > 70
                ? theme.fg("warning", contextDisplay)
                : contextDisplay;
            statsParts.push(contextText);

            let statsLeft = statsParts.join(" ");
            if (visibleWidth(statsLeft) > width) {
              statsLeft = truncateToWidth(statsLeft, width, "...");
            }
            const statsLeftWidth = visibleWidth(statsLeft);

            const modelLabel = fastStatus ? `${model?.id ?? "no-model"} ${fastStatus}` : model?.id ?? "no-model";
            let rightSide = modelLabel;
            if (model?.reasoning) {
              const level = pi.getThinkingLevel?.() ?? "off";
              rightSide = level === "off" ? `${modelLabel} • thinking off` : `${modelLabel} • ${level}`;
            }
            if (footerData.getAvailableProviderCount() > 1 && model) {
              const withProvider = `(${model.provider}) ${rightSide}`;
              if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
            }

            const rightWidth = visibleWidth(rightSide);
            let statsLine: string;
            if (statsLeftWidth + 2 + rightWidth <= width) {
              statsLine = theme.fg("dim", statsLeft) + theme.fg("dim", " ".repeat(width - statsLeftWidth - rightWidth) + rightSide);
            } else {
              const available = Math.max(0, width - statsLeftWidth - 2);
              const truncatedRight = available > 0 ? truncateToWidth(rightSide, available, "") : "";
              const pad = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
              statsLine = theme.fg("dim", statsLeft) + theme.fg("dim", pad + truncatedRight);
            }

            return [pwdLine, statsLine];
          },
        };
      });
    };

    installFooter();
    // Session creation/reload may briefly reset extension UI while other extensions
    // finish binding. Reinstall after startup so this custom footer keeps ownership
    // while still reading status data from extensionStatuses.
    setTimeout(installFooter, 0);
    setTimeout(installFooter, 100);
  });
}
