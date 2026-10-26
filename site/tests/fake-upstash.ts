import { createServer, type Server } from 'node:http';

/**
 * A tiny stand-in for Upstash Redis's REST API, holding data in memory. Supports the commands the site uses.
 * Run on its own (`npx tsx tests/fake-upstash.ts`, port from FAKE_UPSTASH_PORT) or start it from a test.
 */
export const FAKE_UPSTASH_TOKEN = 'fake-upstash-token';

export function startFakeUpstash(port = 0): Promise<{ url: string; server: Server; data: Map<string, unknown>; commands: string[][] }> {
  const data = new Map<string, string | Map<string, string>>();
  const expires = new Map<string, number>();
  const commands: string[][] = [];

  const live = (k: string) => {
    const t = expires.get(k);
    if (t !== undefined && t <= Date.now()) {
      data.delete(k);
      expires.delete(k);
    }
    return data.get(k);
  };

  function run(cmd: unknown[]): unknown {
    const [name, ...a] = cmd.map(String);
    commands.push([name!.toUpperCase(), ...a]);
    switch (name!.toUpperCase()) {
      case 'PING':
        return 'PONG';
      case 'GET': {
        const v = live(a[0]!);
        return typeof v === 'string' ? v : null;
      }
      case 'MGET':
        return a.map((k) => {
          const v = live(k);
          return typeof v === 'string' ? v : null;
        });
      case 'SET': {
        const [k, v, ...opts] = a;
        const flags = opts.map((o) => o.toUpperCase());
        if (flags.includes('NX') && live(k!) !== undefined) return null;
        data.set(k!, v!);
        expires.delete(k!);
        const px = flags.indexOf('PX');
        const ex = flags.indexOf('EX');
        if (px >= 0) expires.set(k!, Date.now() + Number(opts[px + 1]));
        if (ex >= 0) expires.set(k!, Date.now() + Number(opts[ex + 1]) * 1000);
        return 'OK';
      }
      case 'DEL':
        return a.filter((k) => (live(k) !== undefined ? data.delete(k) : false)).length;
      case 'HSET': {
        const [k, ...pairs] = a;
        let h = live(k!);
        if (!(h instanceof Map)) data.set(k!, (h = new Map()));
        let added = 0;
        for (let i = 0; i < pairs.length; i += 2) {
          if (!h.has(pairs[i]!)) added++;
          h.set(pairs[i]!, pairs[i + 1]!);
        }
        return added;
      }
      case 'HGET': {
        const h = live(a[0]!);
        return h instanceof Map ? (h.get(a[1]!) ?? null) : null;
      }
      case 'HGETALL': {
        const h = live(a[0]!);
        return h instanceof Map ? [...h].flat() : [];
      }
      case 'FLUSHALL':
        data.clear();
        return 'OK';
      default:
        throw new Error(`fake upstash: unsupported command ${name}`);
    }
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/health') return send(200, { result: 'ok' });
      if (req.headers.authorization !== `Bearer ${FAKE_UPSTASH_TOKEN}`) return send(401, { error: 'Unauthorized' });
      try {
        const parsed = JSON.parse(body || '[]') as unknown[];
        if (req.url?.startsWith('/pipeline') || req.url?.startsWith('/multi-exec')) {
          return send(200, (parsed as unknown[][]).map((c) => {
            try {
              return { result: run(c) };
            } catch (e) {
              return { error: (e as Error).message };
            }
          }));
        }
        return send(200, { result: run(parsed) });
      } catch (e) {
        return send(400, { error: (e as Error).message });
      }
    });
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${p}`, server, data: data as Map<string, unknown>, commands });
    }),
  );
}

if (process.argv[1] && /fake-upstash\.ts$/.test(process.argv[1])) {
  const port = Number(process.env['FAKE_UPSTASH_PORT'] ?? 4396);
  void startFakeUpstash(port).then(({ url }) => console.log(`fake upstash on ${url}`));
}
