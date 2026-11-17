// F3a: N-HTTP, N-PATH e N-WS-OPEN com servidor e WebSocket simulados (sem rede).
import { describe, expect, it } from 'vitest';
import { basesFor, echoText, healthUrl, httpResult, pathResult, probeHealth, runPathChecks, WsOpenTest, type WsCtor } from './tests/c-net';
import { fakeFetch, fakeWs, HEALTH, now, PAGE, res, server, T, TICKET, type Handler } from './test-helpers/net-fakes';

describe('N-PATH e N-HTTP', () => {
  it('URLs: relativo e /.proxy usam a origem da página; absoluto usa o servidor fixo no código', () => {
    expect(healthUrl('relativo', PAGE)).toBe(`${PAGE}/net/health`);
    expect(healthUrl('proxy', PAGE)).toBe(`${PAGE}/.proxy/net/health`);
    expect(healthUrl('absoluto', PAGE)).toBe('https://sonda.kingszin.com.br/net/health');
  });

  it('dentro do Discord: /net funciona e o absoluto é barrado → N-PATH AP (prefixo vazio), N-HTTP AP pelo proxy', async () => {
    const f = fakeFetch((url) => (url.startsWith(PAGE) && url.endsWith('/net/health') && !url.includes('.proxy') ? res(200, HEALTH(false)) : url.includes('kingszin') ? 'falha' : res(404, 'nada')));
    const run = await runPathChecks({ fetch: f, now, timeoutMs: T }, 'discord', PAGE);
    const p = pathResult(run, 'discord');
    expect(p).toMatchObject({ status: 'AP', working_prefix: '' });
    expect(p.routes.map((r) => [r.route, r.json_ok, r.error])).toEqual([['relativo', true, null], ['proxy', false, 'http'], ['absoluto', false, 'rede']]);
    const h = httpResult(run, 'discord');
    expect(h).toMatchObject({ status: 'AP', route: 'relativo', server_open: false, server_region: 'us-phoenix-1', server_host: 'sonda.kingszin.com.br' });
    expect(h.detail).toContain('fechada');
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('só /.proxy funciona → AP com prefixo /.proxy', async () => {
    const f = fakeFetch((url) => (url.includes('/.proxy/net/health') ? res(200, HEALTH(true)) : res(404, 'x')));
    const run = await runPathChecks({ fetch: f, now, timeoutMs: T }, 'discord', PAGE);
    expect(pathResult(run, 'discord')).toMatchObject({ status: 'AP', working_prefix: '/.proxy' });
    expect(httpResult(run, 'discord')).toMatchObject({ status: 'AP', route: 'proxy' });
  });

  it('mapeamento errado (Discord tira o prefixo → 404 do Caddy) → RP com a dica do alvo /net', async () => {
    const f = fakeFetch((url) => (url.includes('kingszin') ? 'falha' : res(404, '')));
    const run = await runPathChecks({ fetch: f, now, timeoutMs: T }, 'discord', PAGE);
    const p = pathResult(run, 'discord');
    expect(p.status).toBe('RP');
    expect(p.detail).toContain('sonda.kingszin.com.br/net');
    expect(httpResult(run, 'discord')).toMatchObject({ status: 'RP', route: 'relativo', http_status: 404, error: 'http' });
  });

  it('o proxy devolve uma página HTML (200, não JSON) → não conta como servidor', async () => {
    const f = fakeFetch(() => res(200, '<!doctype html><title>Sonda</title>'));
    const run = await runPathChecks({ fetch: f, now, timeoutMs: T }, 'discord', PAGE);
    expect(pathResult(run, 'discord').status).toBe('RP');
    expect(run.routes[0]).toMatchObject({ json_ok: false, error: 'json', http_status: 200 });
  });

  it('JSON que não é o health da sonda também não conta', async () => {
    const f = fakeFetch(() => res(200, JSON.stringify({ aberto: 'sim' })));
    const p = await probeHealth({ fetch: f, now, timeoutMs: T }, 'relativo', `${PAGE}/net/health`);
    expect(p).toMatchObject({ json_ok: false, error: 'json', server_open: null });
  });

  it('servidor que não responde → "tempo" (não "rede")', async () => {
    const f = fakeFetch(() => 'trava');
    const p = await probeHealth({ fetch: f, now, timeoutMs: T }, 'absoluto', 'https://sonda.kingszin.com.br/net/health');
    expect(p.error).toBe('tempo');
  });

  it('fora do Discord: só o endereço direto é testado; N-PATH SKIP, N-HTTP pelo direto', async () => {
    const f = fakeFetch(server());
    const run = await runPathChecks({ fetch: f, now, timeoutMs: T }, 'standalone', 'https://enzo-rbt0.github.io');
    expect(f.calls.map((c) => c.url)).toEqual(['https://sonda.kingszin.com.br/net/health']);
    expect(pathResult(run, 'standalone').status).toBe('SKIP');
    expect(httpResult(run, 'standalone')).toMatchObject({ status: 'AP', route: 'absoluto', server_open: true });
  });

  it('antes da verificação terminar: SKIP "verificando…"', () => {
    expect(httpResult(null, 'discord')).toMatchObject({ status: 'SKIP', detail: 'verificando…' });
    expect(pathResult(null, 'discord')).toMatchObject({ status: 'SKIP', detail: 'verificando…' });
  });

  it('bases: Discord usa a própria origem (+ prefixo); fora usa o servidor fixo', () => {
    const loc = { protocol: 'https:', host: '1571332639812493522.discordsays.com', origin: PAGE };
    expect(basesFor('discord', loc, '')).toEqual({ httpBase: PAGE, wsBase: 'wss://1571332639812493522.discordsays.com' });
    expect(basesFor('discord', loc, '/.proxy')).toEqual({ httpBase: `${PAGE}/.proxy`, wsBase: 'wss://1571332639812493522.discordsays.com/.proxy' });
    expect(basesFor('standalone', loc, null)).toEqual({ httpBase: 'https://sonda.kingszin.com.br', wsBase: 'wss://sonda.kingszin.com.br' });
  });
});

describe('N-WS-OPEN', () => {
  const bases = { httpBase: PAGE, wsBase: 'wss://1571332639812493522.discordsays.com' };
  const make = (h: Handler, ws: WsCtor) => new WsOpenTest({ fetch: fakeFetch(h), now, timeoutMs: T, WebSocket: ws });

  it('antes de rodar: SKIP; pular: SKIP "pulado"', () => {
    const t = make(server(), fakeWs('ok'));
    expect(t.result()).toMatchObject({ status: 'SKIP', ran: false, attempts: [] });
    t.skip();
    expect(t.result().detail).toBe('pulado');
  });

  it('5 de 5 abertas com eco → AP; bilhete vai só na URL do WebSocket e nunca no resultado', async () => {
    const f = fakeFetch(server());
    const W = fakeWs('ok');
    const t = new WsOpenTest({ fetch: f, now, timeoutMs: T, WebSocket: W });
    await t.run(bases);
    const r = t.result();
    expect(r).toMatchObject({ status: 'AP', opened: 5, echoed: 5, window_open: true });
    expect(r.attempts.every((a) => a.close_code === 1000 && !a.closed_by_server)).toBe(true);
    expect(W.urls).toHaveLength(5);
    expect(W.urls[0]).toBe(`wss://1571332639812493522.discordsays.com/net/ws/echo?bilhete=${TICKET}`);
    expect(W.closes.every((c) => c === 1000)).toBe(true);
    const sessions = f.calls.filter((c) => c.url.endsWith('/net/session'));
    expect(sessions).toHaveLength(5);
    expect(JSON.parse(sessions[0]!.body!)).toEqual({ kind: 'echo', duration_s: 5 });
    expect(JSON.stringify(r)).not.toContain(TICKET);
  });

  it('rede fechada no servidor → INV, sem gastar nenhuma admissão', async () => {
    const f = fakeFetch(server({ health: res(200, HEALTH(false)) }));
    const t = new WsOpenTest({ fetch: f, now, timeoutMs: T, WebSocket: fakeWs('ok') });
    await t.run(bases);
    expect(t.result()).toMatchObject({ status: 'INV', window_open: false, attempts: [] });
    expect(f.calls.some((c) => c.url.endsWith('/net/session'))).toBe(false);
  });

  it('servidor inacessível pelo caminho da sonda → RP', async () => {
    const t = make(() => res(404, ''), fakeWs('ok'));
    await t.run(bases);
    expect(t.result()).toMatchObject({ status: 'RP', attempts: [] });
  });

  it('WebSocket recusado antes de abrir (403/503 no upgrade = 1006 no navegador) → RP com a etapa "upgrade"', async () => {
    const t = make(server(), fakeWs('recusa'));
    await t.run(bases);
    const r = t.result();
    expect(r).toMatchObject({ status: 'RP', opened: 0 });
    expect(r.attempts[0]).toMatchObject({ failed_stage: 'upgrade', close_code: 1006, closed_by_server: true, open_ok: false });
    expect(r.detail).toContain('upgrade');
  });

  it('WebSocket que não abre em 5 s → falha "upgrade" por tempo e fecha a tentativa', async () => {
    const W = fakeWs('trava');
    const t = make(server(), W);
    await t.run(bases);
    expect(t.result().attempts[0]).toMatchObject({ failed_stage: 'upgrade', error: 'WebSocket não abriu em 5 s' });
    expect(W.closes.length).toBeGreaterThan(0);
  });

  it('3 de 5 abertas → INV; abertas contam mesmo se o eco falhar (o critério é a abertura)', async () => {
    const t = make(server(), fakeWs(['ok', 'recusa', 'eco-mudo', 'recusa', 'ok']));
    await t.run(bases);
    const r = t.result();
    expect(r).toMatchObject({ status: 'INV', opened: 3, echoed: 2 });
    expect(r.attempts[2]).toMatchObject({ open_ok: true, echo_ok: false, failed_stage: 'eco', error: 'eco não voltou em 5 s' });
  });

  it('servidor fecha com 4002 antes do eco → registrado como fechamento do servidor', async () => {
    const t = make(server(), fakeWs('fecha-4002'));
    await t.run(bases);
    expect(t.result().attempts[0]).toMatchObject({ open_ok: true, echo_ok: false, closed_by_server: true, close_code: 4002, failed_stage: 'eco' });
  });

  it('eco em binário (como o servidor real devolve) conta como eco; o cliente pede binaryType arraybuffer', async () => {
    const W = fakeWs('eco-binario');
    const t = make(server(), W);
    await t.run(bases);
    expect(t.result()).toMatchObject({ status: 'AP', opened: 5, echoed: 5 });
  });

  it('echoText: texto, ArrayBuffer e Uint8Array (Buffer do Node) viram o mesmo texto; Blob não', () => {
    const b = new TextEncoder().encode('bt3probe-eco');
    expect(echoText('bt3probe-eco')).toBe('bt3probe-eco');
    expect(echoText(b.buffer)).toBe('bt3probe-eco');
    expect(echoText(b)).toBe('bt3probe-eco');
    expect(echoText(new Blob(['x']))).toBeNull();
  });

  it('eco diferente do enviado → não conta como eco', async () => {
    const t = make(server(), fakeWs('eco-errado'));
    await t.run(bases);
    expect(t.result().attempts[0]).toMatchObject({ echo_ok: false, error: 'eco diferente do enviado' });
  });

  it('admissão 403 (origem não reconhecida) → RP explicando a origem; não abre WebSocket', async () => {
    const W = fakeWs('ok');
    const t = make(server({ session: res(403, '{"erro":"origem não permitida"}') }), W);
    await t.run(bases);
    const r = t.result();
    expect(r.status).toBe('RP');
    expect(r.attempts).toHaveLength(5);
    expect(r.attempts[0]).toMatchObject({ admit_status: 403, failed_stage: 'admissao' });
    expect(r.detail).toContain('origem');
    expect(W.urls).toHaveLength(0);
  });

  it('admissão 429 (limite do dia) → para na 1ª tentativa e dá INV, sem gastar as outras', async () => {
    const f = fakeFetch(server({ session: res(429, '{"erro":"limite de admissões do dia"}') }));
    const t = new WsOpenTest({ fetch: f, now, timeoutMs: T, WebSocket: fakeWs('ok') });
    await t.run(bases);
    const r = t.result();
    expect(r).toMatchObject({ status: 'INV' });
    expect(r.attempts).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.endsWith('/net/session'))).toHaveLength(1);
  });

  it('admissão 503 (janela fechou no meio) → também para e dá INV', async () => {
    const t = make(server({ session: res(503, '{"erro":"rede fechada"}') }), fakeWs('ok'));
    await t.run(bases);
    expect(t.result()).toMatchObject({ status: 'INV' });
    expect(t.result().attempts).toHaveLength(1);
  });

  it('admissão sem bilhete válido → falha "admissao" sem abrir WebSocket', async () => {
    const W = fakeWs('ok');
    const t = make(server({ session: res(201, JSON.stringify({ bilhete: 'nao-hex' })) }), W);
    await t.run(bases);
    expect(t.result().attempts[0]).toMatchObject({ failed_stage: 'admissao', error: 'admissão falhou: resposta sem bilhete' });
    expect(W.urls).toHaveLength(0);
  });

  it('enquanto roda: SKIP "em andamento"; não roda duas vezes ao mesmo tempo', async () => {
    const W = fakeWs('ok');
    const t = make(server(), W);
    const p1 = t.run(bases);
    expect(t.isRunning()).toBe(true);
    expect(t.result().detail).toContain('em andamento');
    await Promise.all([p1, t.run(bases)]);
    expect(W.urls).toHaveLength(5);
    expect(t.isRunning()).toBe(false);
  });

});
