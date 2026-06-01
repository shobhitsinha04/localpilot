import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";

import {
  DEFAULT_TIER,
  EMBEDDING_MODEL,
  MIN_MACOS_MAJOR_FOR_METAL,
  TIER_2_MIN_GB,
  TIER_3_MAX_GB,
  TIER_3_MIN_GB,
  TIER_MODELS,
  TIER_REQUIRED_DISK_GB,
} from "../constants";
import type {
  ChipGeneration,
  ChipVariant,
  HardwareProfile,
  Logger,
  ModelSet,
  Tier,
} from "../types";

const execFileAsync = promisify(execFile);

const BYTES_PER_GB = 1024 ** 3;

// ----------------------------------------------------------------------------
// Pure helpers (unit-tested directly — no system calls)
// ----------------------------------------------------------------------------

/**
 * Map total unified memory (GiB) to a tier. Boundaries (HARDWARE_PROFILES.md;
 * 36GB resolves to Tier 3 — DECISIONS 012):
 *   < 16 -> 1, 16..<24 -> 2, 24..36 -> 3, > 36 -> 4
 */
export function mapMemoryToTier(totalMemoryGB: number): Tier {
  if (totalMemoryGB < TIER_2_MIN_GB) return 1;
  if (totalMemoryGB < TIER_3_MIN_GB) return 2;
  if (totalMemoryGB <= TIER_3_MAX_GB) return 3;
  return 4;
}

/**
 * Step a tier down while there isn't enough free disk for its model download
 * (HARDWARE_PROFILES.md: "Insufficient disk space for assigned tier: fall back
 * to the next tier down"). Never falls below Tier 1.
 */
export function applyDiskFallback(tier: Tier, availableDiskGB: number): Tier {
  let result = tier;
  while (result > 1 && availableDiskGB < TIER_REQUIRED_DISK_GB[result]) {
    result = (result - 1) as Tier;
  }
  return result;
}

/** True when the CPU brand string indicates Apple Silicon (e.g. "Apple M2"). */
export function parseIsAppleSilicon(chipBrand: string): boolean {
  return /^Apple\s+M\d/i.test(chipBrand.trim());
}

/** Extract chip generation + variant from "Apple M3 Pro" style brand strings. */
export function parseChip(chipBrand: string): {
  generation: ChipGeneration;
  variant: ChipVariant;
} {
  const genMatch = chipBrand.match(/\bM([1-4])\b/);
  const generation: ChipGeneration = genMatch
    ? (`M${genMatch[1]}` as ChipGeneration)
    : "unknown";

  let variant: ChipVariant;
  if (/\bUltra\b/i.test(chipBrand)) variant = "Ultra";
  else if (/\bMax\b/i.test(chipBrand)) variant = "Max";
  else if (/\bPro\b/i.test(chipBrand)) variant = "Pro";
  else if (generation === "unknown") variant = "unknown";
  else variant = "base";

  return { generation, variant };
}

/** Parse the major number from a macOS version string ("14.5" -> 14). */
export function parseMacosMajor(version: string): number {
  const major = Number.parseInt(version.trim().split(".")[0] ?? "", 10);
  return Number.isNaN(major) ? 0 : major;
}

/** Resolve the chat/autocomplete/embedding models for a tier. */
export function modelsForTier(tier: Tier): ModelSet {
  return {
    chat: TIER_MODELS[tier].chat,
    autocomplete: TIER_MODELS[tier].autocomplete,
    embedding: EMBEDDING_MODEL,
  };
}

// ----------------------------------------------------------------------------
// Detector (performs the actual system calls)
// ----------------------------------------------------------------------------

export class HardwareDetector {
  constructor(private readonly logger: Logger) {}

  /**
   * Read hardware via native macOS commands and map to a tier. Never throws:
   * Intel Macs return an unsupported profile, and any failure defaults to
   * Tier 2 (HARDWARE_PROFILES.md "Detection fails entirely").
   */
  async detect(): Promise<HardwareProfile> {
    try {
      const [memRaw, chipRaw, osRaw] = await Promise.all([
        this.sysctl("hw.memsize"),
        this.sysctl("machdep.cpu.brand_string"),
        this.productVersion(),
      ]);

      const chipBrand = chipRaw.trim();
      const totalMemoryGB = Math.round(Number(memRaw.trim()) / BYTES_PER_GB);
      const macosVersion = osRaw.trim();
      const macosMajor = parseMacosMajor(macosVersion);
      const metalSupported = macosMajor >= MIN_MACOS_MAJOR_FOR_METAL;

      if (!parseIsAppleSilicon(chipBrand)) {
        return this.unsupportedProfile(chipBrand, totalMemoryGB);
      }

      const { generation, variant } = parseChip(chipBrand);
      const availableDiskGB = await this.availableDiskGB();
      const ramTier = mapMemoryToTier(totalMemoryGB);
      const tier = applyDiskFallback(ramTier, availableDiskGB);

      if (tier !== ramTier) {
        this.logger.warn(
          `Only ${availableDiskGB}GB free disk; falling back from Tier ${ramTier} to Tier ${tier}.`,
        );
      }

      return {
        supported: true,
        isAppleSilicon: true,
        chipBrand,
        chipGeneration: generation,
        chipVariant: variant,
        totalMemoryGB,
        availableDiskGB,
        macosVersion,
        macosMajor,
        metalSupported,
        tier,
        detectionFailed: false,
      };
    } catch (err) {
      this.logger.error("Hardware detection failed; defaulting to Tier 2", err);
      return this.defaultProfile();
    }
  }

  private async sysctl(key: string): Promise<string> {
    const { stdout } = await execFileAsync("sysctl", ["-n", key]);
    return stdout;
  }

  private async productVersion(): Promise<string> {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"]);
    return stdout;
  }

  private async availableDiskGB(): Promise<number> {
    try {
      const stats = await statfs(homedir());
      return Math.floor((stats.bavail * stats.bsize) / BYTES_PER_GB);
    } catch (err) {
      // Don't let a disk-stat failure wrongly downgrade the tier.
      this.logger.warn(
        `Disk space detection failed; assuming ample space. ${String(err)}`,
      );
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private unsupportedProfile(
    chipBrand: string,
    totalMemoryGB: number,
  ): HardwareProfile {
    return {
      supported: false,
      unsupportedReason:
        "LocalPilot v1 supports Apple Silicon only. Intel support is coming.",
      isAppleSilicon: false,
      chipBrand,
      chipGeneration: "unknown",
      chipVariant: "unknown",
      totalMemoryGB,
      availableDiskGB: 0,
      macosVersion: "",
      macosMajor: 0,
      metalSupported: false,
      tier: DEFAULT_TIER,
      detectionFailed: false,
    };
  }

  private defaultProfile(): HardwareProfile {
    return {
      supported: true,
      isAppleSilicon: true,
      chipBrand: "unknown",
      chipGeneration: "unknown",
      chipVariant: "unknown",
      totalMemoryGB: 0,
      availableDiskGB: Number.MAX_SAFE_INTEGER,
      macosVersion: "",
      macosMajor: MIN_MACOS_MAJOR_FOR_METAL,
      metalSupported: true,
      tier: DEFAULT_TIER,
      detectionFailed: true,
    };
  }
}
