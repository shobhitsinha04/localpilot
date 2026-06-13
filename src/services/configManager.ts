import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { Logger, LocalPilotConfig } from "../types";

/**
 * Reads and writes config.json in the extension's global storage directory.
 *
 * Takes a plain `storageDir` string rather than the VS Code ExtensionContext so
 * it stays unit-testable without the vscode API. extension.ts passes
 * `context.globalStorageUri.fsPath`.
 */
export class ConfigManager {
  private readonly configPath: string;
  private cache?: LocalPilotConfig;

  constructor(
    private readonly storageDir: string,
    private readonly logger?: Logger,
  ) {
    this.configPath = path.join(storageDir, "config.json");
  }

  /** The Phase 1 config schema with safe initial values. */
  static defaults(): LocalPilotConfig {
    return {
      onboardingComplete: false,
      tier: null,
      chatModel: null,
      autocompleteModel: null,
      embeddingModel: null,
      workspaceIndexes: {},
      inlineCompletionsEnabled: true,
    };
  }

  /**
   * Load config.json. Returns defaults if the file is missing. A corrupt file
   * is logged and replaced with defaults rather than crashing activation.
   */
  async load(): Promise<LocalPilotConfig> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LocalPilotConfig>;
      this.cache = { ...ConfigManager.defaults(), ...parsed };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.warn(
          `config.json unreadable (${String(err)}); using defaults.`,
        );
      }
      this.cache = ConfigManager.defaults();
    }
    return this.cache;
  }

  /** Persist a full config object, creating the storage dir if needed. */
  async save(config: LocalPilotConfig): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(config, null, 2), "utf8");
    this.cache = config;
  }

  /** Merge a partial patch into the current config and persist it. */
  async update(patch: Partial<LocalPilotConfig>): Promise<LocalPilotConfig> {
    const current = this.cache ?? (await this.load());
    const next = { ...current, ...patch };
    await this.save(next);
    return next;
  }

  /** The last loaded/saved config, or defaults if nothing is cached yet. */
  get(): LocalPilotConfig {
    return this.cache ?? ConfigManager.defaults();
  }
}
