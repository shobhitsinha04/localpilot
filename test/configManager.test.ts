import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigManager } from "../src/services/configManager";

describe("ConfigManager", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "localpilot-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when config.json does not exist", async () => {
    const config = new ConfigManager(dir);
    expect(await config.load()).toEqual(ConfigManager.defaults());
  });

  it("round-trips a saved config", async () => {
    const config = new ConfigManager(dir);
    await config.update({ tier: 3, chatModel: "qwen2.5-coder:14b" });

    const reloaded = new ConfigManager(dir);
    const loaded = await reloaded.load();
    expect(loaded.tier).toBe(3);
    expect(loaded.chatModel).toBe("qwen2.5-coder:14b");
    expect(loaded.onboardingComplete).toBe(false);
    expect(loaded.workspaceIndexes).toEqual({});
  });

  it("merges partial patches over the defaults", async () => {
    const config = new ConfigManager(dir);
    await config.load();
    const next = await config.update({ onboardingComplete: true });
    expect(next.onboardingComplete).toBe(true);
    expect(next.tier).toBeNull();
  });

  it("falls back to defaults on a corrupt file without throwing", async () => {
    await writeFile(path.join(dir, "config.json"), "{ not json", "utf8");
    const config = new ConfigManager(dir);
    expect(await config.load()).toEqual(ConfigManager.defaults());
  });

  it("backfills missing keys from defaults", async () => {
    // An older/partial file lacking newer keys should still load cleanly.
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ tier: 2 }),
      "utf8",
    );
    const config = new ConfigManager(dir);
    const loaded = await config.load();
    expect(loaded.tier).toBe(2);
    expect(loaded.embeddingModel).toBeNull();
    expect(loaded.workspaceIndexes).toEqual({});
  });

  it("rejects (does not silently swallow) when the storage dir can't be created", async () => {
    // Point the storage dir under an existing *file* so mkdir fails (ENOTDIR).
    // A failed save must surface as a rejection so callers don't proceed as if
    // state was persisted.
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const config = new ConfigManager(path.join(blocker, "nested"));
    await expect(config.save(ConfigManager.defaults())).rejects.toThrow();
  });
});
