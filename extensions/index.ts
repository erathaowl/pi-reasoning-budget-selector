import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  applyReasoningRules,
  CONFIG_FILE_NAME,
  loadEffectiveConfig,
  type ReasoningRule,
  type ThinkingLevel,
} from "./config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function reasoningByThinking(pi: ExtensionAPI): void {
  let rules: readonly ReasoningRule[] = [];

  pi.on("session_start", async (_event, ctx) => {
    const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
    const projectPath = ctx.isProjectTrusted()
      ? join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
      : undefined;

    try {
      rules = (await loadEffectiveConfig(globalPath, projectPath)).rules;
    } catch (error) {
      rules = [];
      if (ctx.hasUI) {
        ctx.ui.notify(`reasoning-by-thinking: ${(error as Error).message}`, "error");
      }
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model || !isRecord(event.payload)) {
      return;
    }

    applyReasoningRules(
      event.payload,
      rules,
      ctx.model.provider,
      ctx.model.id,
      ctx.thinkingLevel as ThinkingLevel,
    );
  });
}
