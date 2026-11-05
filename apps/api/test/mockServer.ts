import { setTransportForTesting } from '../src/publish/http';

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  bodyBytes: number;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

/** Yönlendirme tabanlı sahte platform sunucusu: "METHOD host/path-regex" → handler. */
export function mockServer(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const compiled = Object.entries(routes).map(([k, h]) => {
    const [method, pattern] = k.split(' ') as [string, string];
    return { key: k, method, re: new RegExp(`^${pattern}$`), h };
  });
  setTransportForTesting(async (req) => {
    const url = new URL(req.url);
    let body = '';
    let bodyBytes = 0;
    if (req.body) {
      const buf = await req.arrayBuffer();
      bodyBytes = buf.byteLength;
      body = bodyBytes < 64 * 1024 ? new TextDecoder().decode(buf) : '';
    }
    const call: Call = { method: req.method, url, headers: req.headers, body, bodyBytes };
    calls.push(call);
    const target = `${url.host}${url.pathname}`;
    for (const r of compiled) {
      if (r.method === req.method && r.re.test(target)) {
        const n = (counts.get(r.key) ?? 0) + 1;
        counts.set(r.key, n);
        return r.h(call, n);
      }
    }
    return new Response(
      JSON.stringify({ error: { message: `mock yok: ${req.method} ${target}` } }),
      { status: 599 },
    );
  });
  return {
    calls,
    count: (pathPart: string) =>
      calls.filter((c) => `${c.method} ${c.url.host}${c.url.pathname}`.includes(pathPart)).length,
  };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const form = (body: string): URLSearchParams => new URLSearchParams(body);
