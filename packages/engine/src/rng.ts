// Seeded random numbers split into named streams. Each kind of roll (auto shot outcome, damage
// range, procs) draws from its own stream, so two setups simmed with the same seed see the same
// rolls for the same events even when one of them makes more or fewer rolls elsewhere. That keeps
// comparisons between setups low-noise.

function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

// sfc32: small, fast, and good enough for Monte Carlo.
export class Stream {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    [this.a, this.b, this.c, this.d] = hash128(seed);
  }

  // Uniform in [0, 1).
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  // Percent chance, e.g. chance(12.5).
  chance(pct: number): boolean {
    return this.next() * 100 < pct;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

export class Rng {
  private streams = new Map<string, Stream>();

  constructor(private seed: string) {}

  stream(name: string): Stream {
    let s = this.streams.get(name);
    if (!s) {
      s = new Stream(`${this.seed}/${name}`);
      this.streams.set(name, s);
    }
    return s;
  }
}
