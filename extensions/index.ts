import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_FILE_NAME,
  loadEffectiveConfig,
  type ReasoningRule,
  validateBudgetForModel,
} from "./config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function handleBeforeProviderRequest(
  event: { payload: unknown },
  ctx: ExtensionContext,
  rules: readonly ReasoningRule[],
  shownWarnings: Set<string>,
): void {
  const model = ctx.model;
  const level = ctx.thinkingLevel;
  if (!model || !level || !isRecord(event.payload)) {
    return;
  }

  const matchingRules = rules.filter(
    (rule) => rule.provider === model.provider && rule.model === model.id,
  );

  if (level === "off") {
    for (const rule of matchingRules) {
      delete event.payload[rule.parameter];
    }
    return;
  }

  const assignments = matchingRules.flatMap((rule) => {
    const budget = rule.budgets[level];
    return budget === undefined ? [] : [{ rule, budget }];
  });
  const validatedAssignments = assignments.map((assignment) => ({
    ...assignment,
    validation: validateBudgetForModel(
      assignment.budget,
      model.contextWindow,
      model.maxTokens,
    ),
  }));

  for (const { budget, validation } of validatedAssignments) {
    if (!validation.error) {
      continue;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(
        `reasoning-by-thinking: budget ${budget} for ${model.provider}/${model.id} is invalid: ${validation.error}`,
        "error",
      );
    }
    ctx.abort();
    return;
  }

  for (const { rule, budget, validation } of validatedAssignments) {
    for (const warning of validation.warnings) {
      const warningKey = JSON.stringify([
        model.provider,
        model.id,
        level,
        budget,
        model.contextWindow,
        model.maxTokens,
        warning.type,
      ]);
      if (shownWarnings.has(warningKey)) {
        continue;
      }
      shownWarnings.add(warningKey);

      if (ctx.hasUI) {
        const message =
          warning.type === "output-headroom"
            ? `reasoning-by-thinking: budget ${budget} for ${model.provider}/${model.id} leaves only ${warning.headroom} output tokens (maxTokens=${model.maxTokens})`
            : `reasoning-by-thinking: model ${model.provider}/${model.id} leaves only ${warning.headroom} tokens between maxTokens and contextWindow`;
        ctx.ui.notify(message, "warning");
      }
    }

    event.payload[rule.parameter] = budget;
  }
}

export default function reasoningByThinking(pi: ExtensionAPI): void {
  let rules: readonly ReasoningRule[] = [];
  const shownWarnings = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    shownWarnings.clear();
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
    handleBeforeProviderRequest(event, ctx, rules, shownWarnings);
  });
}
