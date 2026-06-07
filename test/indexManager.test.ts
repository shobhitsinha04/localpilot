import { describe, expect, it } from "vitest";

import { RECENCY_HALF_LIFE_MS, RERANK_TOP_K } from "../src/constants";
import {
  computeRecency,
  computeSimilarity,
  rerank,
  type RerankRow,
} from "../src/services/indexManager";

function row(partial: Partial<RerankRow>): RerankRow {
  return {
    text: "t",
    filename: "f.ts",
    startLine: 1,
    endLine: 10,
    mtimeMs: 0,
    _distance: 0,
    ...partial,
  };
}

describe("computeSimilarity", () => {
  it("maps cosine distance 0 (identical) to similarity 1", () => {
    expect(computeSimilarity(0)).toBe(1);
  });

  it("decreases as cosine distance grows", () => {
    expect(computeSimilarity(0.4)).toBeCloseTo(0.6, 10);
    expect(computeSimilarity(0.8)).toBeLessThan(computeSimilarity(0.4));
  });

  it("clamps an opposite vector (distance ≥ 1) to 0", () => {
    expect(computeSimilarity(1)).toBe(0);
    expect(computeSimilarity(2)).toBe(0);
  });

  it("clamps a negative distance to 1", () => {
    expect(computeSimilarity(-0.2)).toBe(1);
  });
});

describe("computeRecency", () => {
  const now = 1_000_000_000_000;

  it("scores a just-modified file at 1", () => {
    expect(computeRecency(now, now)).toBe(1);
  });

  it("scores a file one half-life old at 0.5", () => {
    expect(computeRecency(now - RECENCY_HALF_LIFE_MS, now)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("never exceeds 1 for future mtimes", () => {
    expect(computeRecency(now + RECENCY_HALF_LIFE_MS, now)).toBe(1);
  });
});

describe("rerank", () => {
  const now = 1_000_000_000_000;

  it("orders by combined similarity + recency, highest first", () => {
    const rows = [
      row({ filename: "far-recent.ts", _distance: 0.9, mtimeMs: now }),
      row({ filename: "close-old.ts", _distance: 0, mtimeMs: 0 }),
    ];
    const out = rerank(rows, now);
    // close-old: 0.7*1 + 0.3*~0 ≈ 0.70; far-recent: 0.7*0.1 + 0.3*1 = 0.37.
    expect(out[0].filename).toBe("close-old.ts");
  });

  it("lets strong recency override a weaker similarity", () => {
    const rows = [
      row({ filename: "a.ts", _distance: 0.2, mtimeMs: 0 }),
      row({ filename: "b.ts", _distance: 0.5, mtimeMs: now }),
    ];
    const out = rerank(rows, now);
    // a: 0.7*0.8 + 0 = 0.56; b: 0.7*0.5 + 0.3*1 = 0.65.
    expect(out[0].filename).toBe("b.ts");
  });

  it(`returns at most ${RERANK_TOP_K} chunks`, () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ filename: `f${i}.ts`, _distance: i * 0.05 }),
    );
    expect(rerank(rows, now)).toHaveLength(RERANK_TOP_K);
  });

  it("populates similarity, recency, and combined score on each result", () => {
    const out = rerank([row({ _distance: 0.4, mtimeMs: now })], now);
    expect(out[0].similarity).toBeCloseTo(0.6, 10);
    expect(out[0].recency).toBe(1);
    expect(out[0].score).toBeCloseTo(0.7 * 0.6 + 0.3 * 1, 10);
  });
});
