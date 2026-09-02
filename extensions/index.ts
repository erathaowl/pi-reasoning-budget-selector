import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runReasoningBudgetCommand } from "./command.ts";
import {
  CONFIG_FILE_NAME,
  getReasoningBudgetMessage,
  getReasoningBudgetMode,
  loadEffectiveConfig,
  resolveReasoningBudget,
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
  if (!model || !level || !isRecord(event.payload)) return;
  const payload = event.payload;

  const matchingRules = rules.filter(
    (rule) => rule.provider === model.provider && rule.model === model.id,
  );
  if (matchingRules.length === 0) return;

  if (level === "off") {
    for (const rule of matchingRules) delete payload[rule.parameter];
    delete payload.reasoning_budget_message;
    return;
  }

  let removeMessage = false;
  const assignments = matchingRules.flatMap((rule) => {
    if (getReasoningBudgetMode(rule) === "off") {
      delete payload[rule.parameter];
      removeMessage = true;
      return [];
    }
    const budget = resolveReasoningBudget(rule, level);
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
    if (!validation.error) continue;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `reasoning-budget-selector: budget ${budget} for ${model.provider}/${model.id} is invalid: ${validation.error}`,
        "error",
      );
    }
    ctx.abort();
    return;
  }

  let message: string | undefined;
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
      if (shownWarnings.has(warningKey)) continue;
      shownWarnings.add(warningKey);

      if (ctx.hasUI) {
        const warningMessage =
          warning.type === "output-headroom"
            ? `reasoning-budget-selector: budget ${budget} for ${model.provider}/${model.id} leaves only ${warning.headroom} output tokens (maxTokens=${model.maxTokens})`
            : `reasoning-budget-selector: model ${model.provider}/${model.id} leaves only ${warning.headroom} tokens between maxTokens and contextWindow`;
        ctx.ui.notify(warningMessage, "warning");
      }
    }

    payload[rule.parameter] = budget;
    message = getReasoningBudgetMessage(rule);
  }

  if (message !== undefined) payload.reasoning_budget_message = message;
  else if (removeMessage) delete payload.reasoning_budget_message;
}

export default function reasoningBudgetSelector(pi: ExtensionAPI): void {
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
        ctx.ui.notify(`reasoning-budget-selector: ${(error as Error).message}`, "error");
      }
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    handleBeforeProviderRequest(event, ctx, rules, shownWarnings);
  });

  pi.registerCommand("reasoning-budget", {
    description: "Inspect or configure the active model's reasoning budget",
    handler: async (_args, ctx) => {
      const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
      const projectPath = ctx.isProjectTrusted()
        ? join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
        : undefined;
      await runReasoningBudgetCommand(ctx, globalPath, projectPath, {
        setRules(updatedRules) {
          rules = updatedRules;
        },
        clearWarnings() {
          shownWarnings.clear();
        },
      });
    },
  });
}
