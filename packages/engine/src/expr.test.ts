import { expect, test } from "bun:test";
import { compile, type Resolver } from "./expr";

const vars: Record<string, number> = { "mana.pct": 40, "cooldown.rapid_fire.ready": 1, "buff.quick_shots.up": 0 };
const resolve: Resolver = (path) => {
  const key = path.join(".");
  if (!(key in vars)) throw new Error(`unknown ${key}`);
  return () => vars[key]!;
};
const run = (src: string) => compile(src, resolve)();

test("comparisons and boolean logic", () => {
  expect(run("mana.pct > 20 & cooldown.rapid_fire.ready")).toBe(1);
  expect(run("mana.pct > 50 | buff.quick_shots.up")).toBe(0);
  expect(run("!buff.quick_shots.up")).toBe(1);
});

test("precedence: arithmetic binds tighter than comparison, & tighter than |", () => {
  expect(run("1 + 2 * 3 = 7")).toBe(1);
  expect(run("0 & 0 | 1")).toBe(1);
  expect(run("(1 | 0) & 0")).toBe(0);
  expect(run("-mana.pct + 50")).toBe(10);
});

test("unknown names and bad syntax fail at compile time", () => {
  expect(() => compile("mana.pc > 1", resolve)).toThrow(/unknown mana.pc/);
  expect(() => compile("mana.pct >", resolve)).toThrow();
  expect(() => compile("(mana.pct > 1", resolve)).toThrow(/expected "\)"/);
});

test("% is a remainder at the precedence of * and /", () => {
  const f = compile("7 % 3 + 1 = 2 & 2 * 5 % 4 = 2", () => () => 0);
  expect(f()).toBe(1);
});
