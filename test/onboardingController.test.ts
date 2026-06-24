import { describe, expect, it } from "vitest";

import { formatEta } from "../src/onboardingController";

describe("formatEta", () => {
  it("returns undefined before any progress or once complete", () => {
    expect(formatEta(10_000, 0)).toBeUndefined();
    expect(formatEta(10_000, -5)).toBeUndefined();
    expect(formatEta(10_000, 100)).toBeUndefined();
    expect(formatEta(10_000, 150)).toBeUndefined();
  });

  it("estimates minutes remaining from elapsed time and percent", () => {
    // 60s elapsed at 50% → ~60s remaining → 1 minute.
    expect(formatEta(60_000, 50)).toBe("about 1 minute remaining");
    // 60s elapsed at 25% → ~180s remaining → 3 minutes.
    expect(formatEta(60_000, 25)).toBe("about 3 minutes remaining");
  });

  it("falls back to seconds under a minute", () => {
    // 60s elapsed at 80% → ~15s remaining.
    expect(formatEta(60_000, 80)).toBe("about 15s remaining");
  });

  it("never reports less than 5 seconds remaining", () => {
    // 10s elapsed at 99% → ~0.1s remaining → floored to 5s.
    expect(formatEta(10_000, 99)).toBe("about 5s remaining");
  });
});
