/**
 * IPC handlers for budget alerts.
 * Wraps budget-alerts.ts.
 */

import {
  getBudgetAlertRules,
  createBudgetAlertRule,
  updateBudgetAlertRule,
  deleteBudgetAlertRule,
  evaluateAllBudgetAlerts,
  type BudgetAlertRule,
  type BudgetAlertResult,
  type BudgetAlertUsage,
  type BudgetAlertScope,
  type BudgetTimeWindow,
  type BudgetThresholdMetric,
} from "../../lib/budget-alerts.js";

/**
 * List all budget alert rules.
 */
export async function listAlerts(): Promise<BudgetAlertRule[]> {
  return getBudgetAlertRules();
}

/**
 * Create a new budget alert rule.
 */
export async function createAlert(params: {
  name: string;
  scope: BudgetAlertScope;
  window: BudgetTimeWindow;
  metric: BudgetThresholdMetric;
  threshold: number;
  direction: "above" | "below";
  enabled?: boolean;
}): Promise<BudgetAlertRule> {
  return createBudgetAlertRule(params);
}

/**
 * Update an existing budget alert rule.
 */
export async function updateAlert(
  id: string,
  params: Partial<Omit<BudgetAlertRule, "id" | "createdAt" | "updatedAt">>,
): Promise<BudgetAlertRule | null> {
  return updateBudgetAlertRule(id, params);
}

/**
 * Delete a budget alert rule.
 */
export async function deleteAlert(id: string): Promise<boolean> {
  return deleteBudgetAlertRule(id);
}

/**
 * Evaluate all enabled alerts against provided usage data.
 *
 * @param usageMap - Array of [key, usage] pairs. Key format: "providerId/modelId" or "__global__"
 * @returns Evaluation results including triggered count
 */
export async function evaluateAlerts(
  usageMap: Array<{ key: string; usage: BudgetAlertUsage }>,
): Promise<{
  results: BudgetAlertResult[];
  triggeredCount: number;
}> {
  const rules = await getBudgetAlertRules();
  const enabledRules = rules.filter((r) => r.enabled);

  const map = new Map<string, BudgetAlertUsage>();
  for (const { key, usage } of usageMap) {
    map.set(key, usage);
  }

  const results = evaluateAllBudgetAlerts(enabledRules, map);
  const triggeredCount = results.filter((r) => r.triggered).length;

  return { results, triggeredCount };
}
