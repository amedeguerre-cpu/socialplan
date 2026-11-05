/**
 * Depo denetimi (statik): Worker kaynaklarında SQL ifadelerine kullanıcı verisi string birleştirmeyle girmez.
 * SQL içeren şablonlardaki `${...}` ifadeleri yalnız koddaki sabitler/sütun adları olabilir (izin listesi);
 * değerler her zaman `?` + bind ile verilir.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../../../apps/api/src');
const SQL = /\b(SELECT|UPDATE|INSERT INTO|DELETE FROM|WHERE|SET)\b/;
const ALLOWED = [
  /^cols\.map\(\(c\) => `\$\{c\} = \?`\)\.join\(', '\)$/,
  /^cond$/,
  /^s\.commitPending \? 'commit_started_at' : 'NULL'$/,
  /^ACTIVE_POST$/,
  /^SELECT_JOINED$/,
  /^w$/,
  /^where\.join\(' AND '\)$/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Satırdaki `${…}` ifadelerini dengeli parantezle çıkar. */
function interpolations(line: string): string[] {
  const out: string[] = [];
  let i = line.indexOf('${');
  while (i >= 0) {
    let depth = 1;
    let j = i + 2;
    while (j < line.length && depth > 0) {
      if (line[j] === '{') depth++;
      else if (line[j] === '}') depth--;
      j++;
    }
    out.push(line.slice(i + 2, j - 1));
    i = line.indexOf('${', j);
  }
  return out;
}

describe('SQL parametre denetimi', () => {
  it('denetleyici kötü örneği yakalar', () => {
    const line = "db.prepare(`SELECT * FROM posts WHERE id = '${c.req.param('id')}'`)";
    expect(interpolations(line)).toEqual(["c.req.param('id')"]);
    expect(ALLOWED.some((re) => re.test("c.req.param('id')"))).toBe(false);
    expect(
      interpolations("`UPDATE posts SET ${cols.map((c) => `${c} = ?`).join(', ')} ${cond}`"),
    ).toEqual(["cols.map((c) => `${c} = ?`).join(', ')", 'cond']);
  });

  it('SQL şablonlarında yalnız izinli (koddan gelen) ifadeler var', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, n) => {
        if (
          !SQL.test(line) ||
          !line.includes('${') ||
          line.includes('/api/') ||
          line.trim().startsWith('//') ||
          line.trim().startsWith('*')
        )
          return;
        if (
          !/[`'"]\s*(SELECT|UPDATE|INSERT|DELETE|WITH)\b|\b(WHERE|SET|FROM|AND|LIMIT)\b.*\?/.test(
            line,
          )
        )
          return;
        for (const expr of interpolations(line)) {
          if (!ALLOWED.some((re) => re.test(expr.trim())))
            offenders.push(`${f.replace(SRC, 'src')}:${n + 1} → \${${expr}}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('Worker kaynaklarında doğrudan fetch yok (yalnız publish/http.ts)', () => {
    const bad = files(SRC).filter(
      (f) =>
        !f.endsWith('publish/http.ts') &&
        /(?<!async )(?<![.\w])fetch\(/m.test(readFileSync(f, 'utf8')),
    );
    expect(bad).toEqual([]);
  });
});
