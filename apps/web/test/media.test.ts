import { describe, expect, it } from 'vitest';
import { moovAtStart, scanTopLevelBoxes, thumbSize, type ReadAt } from '../src/lib/media';
import { pool, withRetry } from '../src/lib/upload';

function box(type: string, payload: number): Uint8Array {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, 8 + payload);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const reader =
  (buf: Uint8Array): ReadAt =>
  async (off, len) =>
    buf.slice(off, off + len).buffer;

describe('moov taraması', () => {
  it('faststart dosyada moov başta', async () => {
    const f = concat(box('ftyp', 16), box('moov', 100), box('mdat', 1000));
    const boxes = await scanTopLevelBoxes(reader(f), f.length);
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(moovAtStart(boxes)).toBe(true);
  });
  it('moov sonda', async () => {
    const f = concat(box('ftyp', 16), box('mdat', 1000), box('moov', 100));
    expect(moovAtStart(await scanTopLevelBoxes(reader(f), f.length))).toBe(false);
  });
  it('bozuk dosyada null', async () => {
    const f = new Uint8Array(64);
    expect(moovAtStart(await scanTopLevelBoxes(reader(f), f.length))).toBeNull();
  });
});

describe('thumbnail yardımcıları', () => {
  it('uzun kenarı sınırlar, oranı korur', () => {
    expect(thumbSize(1080, 1920)).toEqual({ width: 405, height: 720 });
    expect(thumbSize(300, 200)).toEqual({ width: 300, height: 200 });
  });
});

describe('yükleme yardımcıları', () => {
  it('pool eşzamanlılığı sınırlar ve sırayı korur', async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(3);
  });
  it('withRetry geçici hatada yeniden dener', async () => {
    let n = 0;
    const r = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new Error('geçici');
        return 'ok';
      },
      3,
      1,
    );
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
});
