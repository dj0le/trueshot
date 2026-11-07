import { expect, test } from "bun:test";
import { type ClaimRow, drift } from "./claims";

const row = (claim: string, stat: NonNullable<ClaimRow["stat"]>, n: number): ClaimRow => ({ claim, subject: "The Rake (Flipp)", source: "", claimed: "", observed: "", n, verdict: "observed", stat });

test("drift flags a rate that moved and leaves one that held", () => {
  const before = [row("pet crit", { k: 10, n: 3000 }, 3000), row("pet glancing", { k: 210, n: 3000 }, 3000)];
  const after = [row("pet crit", { k: 60, n: 1000 }, 1000), row("pet glancing", { k: 72, n: 1000 }, 1000)];
  const d = drift(before, after);
  expect(d.find((x) => x.claim === "pet crit")!.moved).toBe(true);
  expect(d.find((x) => x.claim === "pet glancing")!.moved).toBe(false);
});

test("drift on means uses both intervals, and small samples give no verdict", () => {
  const moved = drift([row("pet swing speed", { mean: 2.0, ci: 0.02 }, 500)], [row("pet swing speed", { mean: 1.2, ci: 0.02 }, 500)]);
  expect(moved[0]!.moved).toBe(true);
  const held = drift([row("pet swing speed", { mean: 2.0, ci: 0.05 }, 500)], [row("pet swing speed", { mean: 2.03, ci: 0.05 }, 500)]);
  expect(held[0]!.moved).toBe(false);
  const few = drift([row("pet crit", { k: 1, n: 3000 }, 3000)], [row("pet crit", { k: 1, n: 11 }, 11)]);
  expect(few[0]!.moved).toBeUndefined();
});
