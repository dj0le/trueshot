// Condition language for rotation actions, SimulationCraft-style:
//   cooldown.rapid_fire.ready & mana.pct > 20 | !debuff.serpent_sting.up
// Numbers and dotted names, ! - unary, * / + -, < <= > >= = !=, & and |, parentheses.
// Booleans are 1 and 0. Names are resolved once, at compile time, so a typo fails on load.

export type Getter = () => number;
export type Resolver = (path: string[]) => Getter;

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

const OPERATORS = ["<=", ">=", "!=", "<", ">", "=", "&", "|", "!", "+", "-", "*", "/", "(", ")"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i))!;
      tokens.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_.]*/i.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0] });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (!op) throw new Error(`unexpected "${c}" at ${i} in: ${src}`);
      tokens.push({ kind: "op", value: op });
      i += op.length;
    }
  }
  return tokens;
}

const BINARY: Record<string, { prec: number; fn: (a: number, b: number) => number }> = {
  "|": { prec: 1, fn: (a, b) => (a || b ? 1 : 0) },
  "&": { prec: 2, fn: (a, b) => (a && b ? 1 : 0) },
  "=": { prec: 3, fn: (a, b) => (a === b ? 1 : 0) },
  "!=": { prec: 3, fn: (a, b) => (a !== b ? 1 : 0) },
  "<": { prec: 4, fn: (a, b) => (a < b ? 1 : 0) },
  "<=": { prec: 4, fn: (a, b) => (a <= b ? 1 : 0) },
  ">": { prec: 4, fn: (a, b) => (a > b ? 1 : 0) },
  ">=": { prec: 4, fn: (a, b) => (a >= b ? 1 : 0) },
  "+": { prec: 5, fn: (a, b) => a + b },
  "-": { prec: 5, fn: (a, b) => a - b },
  "*": { prec: 6, fn: (a, b) => a * b },
  "/": { prec: 6, fn: (a, b) => (b === 0 ? 0 : a / b) },
};

export function compile(src: string, resolve: Resolver): Getter {
  const tokens = tokenize(src);
  let pos = 0;

  const expectOp = (value: string) => {
    const t = tokens[pos];
    if (t?.kind !== "op" || t.value !== value) throw new Error(`expected "${value}" in: ${src}`);
    pos++;
  };

  function primary(): Getter {
    const t = tokens[pos++];
    if (!t) throw new Error(`unexpected end of: ${src}`);
    if (t.kind === "num") {
      const v = t.value;
      return () => v;
    }
    if (t.kind === "name") return resolve(t.value.split("."));
    if (t.value === "(") {
      const inner = expression(0);
      expectOp(")");
      return inner;
    }
    if (t.value === "!") {
      const inner = primary();
      return () => (inner() ? 0 : 1);
    }
    if (t.value === "-") {
      const inner = primary();
      return () => -inner();
    }
    throw new Error(`unexpected "${t.value}" in: ${src}`);
  }

  function expression(minPrec: number): Getter {
    let left = primary();
    for (;;) {
      const t = tokens[pos];
      const op = t?.kind === "op" ? BINARY[t.value] : undefined;
      if (!op || op.prec < minPrec) return left;
      pos++;
      const right = expression(op.prec + 1);
      const l = left;
      left = () => op.fn(l(), right());
    }
  }

  const result = expression(0);
  if (pos !== tokens.length) throw new Error(`unexpected trailing input in: ${src}`);
  return result;
}
