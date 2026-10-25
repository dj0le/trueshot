// Min-heap of timed callbacks. Events at the same time run in the order they were scheduled.

type Entry = { time: number; seq: number; run: () => void };

export class EventQueue {
  private heap: Entry[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, run: () => void): void {
    this.heap.push({ time, seq: this.seq++, run });
    this.up(this.heap.length - 1);
  }

  peekTime(): number | undefined {
    return this.heap[0]?.time;
  }

  pop(): Entry | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (top && last && this.heap.length > 0) {
      this.heap[0] = last;
      this.down(0);
    }
    return top;
  }

  private less(i: number, j: number): boolean {
    const a = this.heap[i]!;
    const b = this.heap[j]!;
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j]!, this.heap[i]!];
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.heap.length && this.less(l, m)) m = l;
      if (r < this.heap.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
}
