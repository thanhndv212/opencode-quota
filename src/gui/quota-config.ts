import { isAbsolute, resolve } from "path";
import { stat } from "fs/promises";
import { createLoadConfigMeta, loadConfig, type LoadConfigMeta } from "../lib/config.js";
import type { QuotaToastConfig } from "../lib/types.js";
import {
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
} from "../lib/modelsdev-pricing.js";

export interface StandaloneQuotaConfig {
  config: QuotaToastConfig;
  meta: LoadConfigMeta;
  projectRoot?: string;
}

/** Resolve only an explicitly selected project; Finder's cwd never selects one. */
export async function getStandaloneProjectRoot(argv: string[]): Promise<string | undefined> {
  const index = argv.indexOf("--project-dir");
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--project-dir requires a directory");
  const root = resolve(value);
  if (!(await stat(root)).isDirectory()) throw new Error("--project-dir must be a directory");
  return root;
}

export async function loadStandaloneQuotaConfig(
  projectRoot?: string,
): Promise<StandaloneQuotaConfig> {
  const meta = createLoadConfigMeta();
  // An explicit environment root is supported, but require it to be absolute
  // so launching from Finder cannot change which configuration gets loaded.
  const envRoot = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (envRoot && !isAbsolute(envRoot)) {
    throw new Error("Standalone OPENCODE_CONFIG_DIR must be an absolute directory");
  }
  const configRootDir = projectRoot ?? envRoot;
  const config = await loadConfig(undefined, meta, {
    globalOnly: !configRootDir,
    configRootDir,
  });
  setPricingSnapshotAutoRefresh(config.pricingSnapshot.autoRefresh);
  setPricingSnapshotSelection(config.pricingSnapshot.source);
  return { config, meta, projectRoot };
}
