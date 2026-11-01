import { describe, expect, it } from "vitest";
import { DEFAULT_BONUS_FORMULA } from "@kyokkou/config";
import {
  FormulaError,
  evaluateFormula,
  sampleFormula,
  validateFormula,
} from "../src/lib/bonus-formula.js";

function context(overrides: {
  isDonor?: boolean;
  seeders?: number;
  torrents?: { id: number; sizeBytes: number; ageWeeks: number; seeders: number; zeroBonus?: boolean }[];
} = {}) {
  const torrents = (overrides.torrents ?? [
    { id: 1, sizeBytes: 100 * 1024 ** 3, ageWeeks: 10, seeders: 1 },
  ]).map((item) => ({
    ...item,
    ageDays: item.ageWeeks * 7,
    zeroBonus: item.zeroBonus ?? false,
  }));
  const totalBytes = torrents.reduce((sum, item) => sum + item.sizeBytes, 0);
  return {
    user: {
      seeders: overrides.seeders ?? torrents.length,
      totalGb: totalBytes / 1024 ** 3,
      totalBytes,
      avgSizeGb: torrents.length > 0 ? totalBytes / 1024 ** 3 / torrents.length : 0,
      uploaded: 0,
      downloaded: 0,
      ratio: 0,
      ageDays: 30,
      bonus: 0,
      isDonor: overrides.isDonor ?? false,
      hour: 12,
      dayOfWeek: 1,
      userId: 1,
    },
    torrents,
  };
}

describe("bonus formula", () => {
  it("evaluates precedence and variable reassignment in order", () => {
    const result = evaluateFormula(
      "A = 1 + 2 * 3\nA = A - 7\nresult = A + 4 ^ 2 % 5",
      context(),
    );
    expect(result.result).toBe(1); // a = 0；4^2 % 5 = 1
    expect(result.variables.a).toBe(0);
  });

  it("treats a missing result as zero with a warning", () => {
    const result = evaluateFormula("A = 1 + 1", context());
    expect(result.result).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("allows negative results and clamps division by zero to zero", () => {
    expect(evaluateFormula("result = -5", context()).result).toBe(-5);
    expect(evaluateFormula("result = 10 / 0", context()).result).toBe(0);
  });

  it("supports round/floor/ceil/trunc with negative digit positions", () => {
    expect(evaluateFormula("result = round(325, -1)", context()).result).toBe(330);
    expect(evaluateFormula("result = trunc(325, -1)", context()).result).toBe(320);
    expect(evaluateFormula("result = floor(325, -1)", context()).result).toBe(320);
    expect(evaluateFormula("result = ceil(325, -1)", context()).result).toBe(330);
    expect(evaluateFormula("result = round(1.2345, 2)", context()).result).toBe(1.23);
  });

  it("aggregates zero-bonus weight and caps rows at 200 by size", () => {
    const single = evaluateFormula(
      "result = sum(t.size_gb * if(t.is_zero_bonus, 0.2, 1))",
      context({
        torrents: [{ id: 1, sizeBytes: 10 * 1024 ** 3, ageWeeks: 1, seeders: 1, zeroBonus: true }],
      }),
    );
    expect(single.result).toBeCloseTo(2, 8);

    const many = Array.from({ length: 205 }, (_, index) => ({
      id: index + 1,
      sizeBytes: (index + 1) * 1024 ** 3,
      ageWeeks: 1,
      seeders: 1,
      zeroBonus: false,
    }));
    const capped = evaluateFormula("result = count(t.size_gb)", context({ torrents: many }));
    expect(capped.result).toBe(200);
  });

  it("rejects unknown variables, reserved names and nested aggregates", () => {
    expect(() => evaluateFormula("result = missing + 1", context())).toThrow(FormulaError);
    expect(() => evaluateFormula("seeders = 1", context())).toThrow(FormulaError);
    expect(() => evaluateFormula("result = sum(sum(t.size_gb))", context())).toThrow(FormulaError);
  });

  it("rejects non-finite literals/result and parses the NexusPHP default", () => {
    expect(() => evaluateFormula("result = 1 / 0 + pi", context())).not.toThrow();
    const evaluated = evaluateFormula(DEFAULT_BONUS_FORMULA, context());
    expect(evaluated.result).toBeGreaterThan(40);
    expect(evaluated.result).toBeLessThan(50);

    const donor = evaluateFormula(DEFAULT_BONUS_FORMULA, context({ isDonor: true }));
    expect(donor.result).toBeCloseTo(evaluated.result * 3, 0);
  });

  it("reports validation errors with positions and accepts samples", () => {
    const invalid = validateFormula("result = )");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.line).toBeGreaterThan(0);
      expect(invalid.column).toBeGreaterThan(0);
    }
    expect(validateFormula(DEFAULT_BONUS_FORMULA).ok).toBe(true);
    expect(sampleFormula(DEFAULT_BONUS_FORMULA).torrents.length).toBeGreaterThan(0);
  });
});
