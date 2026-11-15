// Servidor HTTP + WebSocket da sonda (F3-0: health, admissão e eco).
// Recusas ANTES do upgrade são respostas HTTP (o WebSocket ainda não existe, então não há código de
// fechamento): 403 bilhete inválido/vencido/reutilizado ou Origin fora da lista; 503 janela fechada,
// servidor encerrando ou erro interno; 404 rota desconhecida. Códigos 4001/4002 só depois do upgrade.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { Budget, DEFAULT_LIMITS, KINDS, type Kind, type Limits } from './budget.js';
import type { Clock, TimerHandle } from './clock.js';
import { WindowWatcher } from './config.js';
import type { Db } from './db.js';
import { makeLogger, type Logger } from './log.js';
import { CLOSE_GOING_AWAY, Conn } from './ws/conn.js';

export const DEFAULT_ORIGINS = ['https://1571332639812493522.discordsays.com', 'https://enzo-rbt0.github.io'];
const MAX_BODY = 256;
export const SWEEP_MS = 1000;

export interface ProbeOptions {
  db: Db;
  clock: Clock;
  windowFile: string;
  processStartedAt: number;
  host?: string;
  port?: number;
  origins?: string[];
  limits?: Limits;
  log?: Logger;
  readWindow?: (p: string) => string | null;
}

export class ProbeServer {
  readonly budget: Budget;
  readonly window: WindowWatcher;
  readonly conns = new Set<Conn>();
  private http: Server;
  private wss: WebSocketServer;
  private sweepTimer: TimerHandle | null = null;
  private stopping = false;
  private limits: Limits;
  private origins: Set<string>;
  private log: Logger;

  constructor(private o: ProbeOptions) {
    this.limits = o.limits ?? DEFAULT_LIMITS;
    this.origins = new Set(o.origins ?? DEFAULT_ORIGINS);
    this.log = o.log ?? makeLogger();
    this.budget = new Budget(o.db, this.limits);
    this.window = new WindowWatcher(o.windowFile, o.clock, o.processStartedAt, o.readWindow);
    // maxPayload é a trava dura do ws; o limite de 64 bytes da sonda é aplicado em Conn (fecha com 4002).
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    this.http = createServer({ maxHeaderSize: 8192 }, (req, res) => this.onRequest(req, res));
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  async start(): Promise<number> {
    // Reinício: o que estava aberto fica gasto e nenhum bilhete antigo vale mais.
    const rec = this.budget.recoverOnStart(this.o.clock.now());
    this.window.start();
    this.sweepTimer = this.o.clock.setInterval(() => this.sweep(), SWEEP_MS);
    await new Promise<void>((resolve) => this.http.listen(this.o.port ?? 0, this.o.host ?? '127.0.0.1', resolve));
    const addr = this.http.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.log('start', { port, closed: rec.closed });
    return port;
  }

  // SIGTERM: para de admitir, fecha as conexões e o servidor.
  async stop(): Promise<void> {
    this.stopping = true;
    this.sweepTimer?.cancel();
    this.window.stop();
    for (const c of [...this.conns]) c.close(CLOSE_GOING_AWAY, 'servidor encerrando');
    // Até 1 s (relógio real) para o aperto de mão de fechamento; depois, corta.
    const deadline = Date.now() + 1000;
    while (this.wss.clients.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    const closed = new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.http.closeAllConnections();
    await closed;
    this.log('parado', {});
  }

  // Segunda trava de prazo e inatividade, independente dos timers de cada conexão.
  sweep(): void {
    for (const c of [...this.conns]) c.check();
  }

  private originOk(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    return typeof o === 'string' && this.origins.has(o);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    if (this.originOk(req)) {
      res.setHeader('access-control-allow-origin', req.headers.origin as string);
      res.setHeader('vary', 'origin');
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0];
    this.cors(req, res);
    try {
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET, POST');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.writeHead(this.originOk(req) ? 204 : 403);
        return void res.end();
      }
      if (req.method === 'GET' && path === '/net/health') return this.health(res);
      if (req.method === 'POST' && path === '/net/session') return this.session(req, res);
      this.json(res, 404, { erro: 'rota desconhecida' });
    } catch {
      this.json(res, 503, { erro: 'erro interno: fechado' });
    }
  }

  private health(res: ServerResponse): void {
    const now = this.o.clock.now();
    const w = this.window.current();
    let uso: unknown = null;
    try {
      const s = this.budget.stats(now);
      uso = { admissoes: s.admissions, mensagens_reservadas: s.reserved_msgs, sessoes_ativas: s.active };
    } catch {
      uso = 'indisponível';
    }
    this.json(res, 200, {
      aberto: w.open && !this.stopping,
      fecha_em: w.open && w.until ? new Date(w.until).toISOString() : null,
      motivo: this.stopping ? 'servidor encerrando' : w.reason,
      tetos: {
        sessoes_simultaneas: this.limits.maxConcurrent,
        admissoes_por_dia: this.limits.maxAdmissionsPerDay,
        mensagens_reservadas_por_dia: this.limits.maxReservedPerDay,
        bytes_por_mensagem: this.limits.maxMsgBytes,
        mensagens_por_segundo: this.limits.maxRatePerSec,
        duracao_maxima_s: this.limits.maxDurationMs / 1000,
        inatividade_s: this.limits.idleMs / 1000,
      },
      uso_do_dia: uso,
    });
  }

  private session(req: IncomingMessage, res: ServerResponse): void {
    if (!this.originOk(req)) return this.json(res, 403, { erro: 'origem não permitida' });
    const tooBig = () => {
      res.setHeader('connection', 'close');
      this.json(res, 413, { erro: 'corpo grande demais' });
      res.on('finish', () => req.destroy());
    };
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return tooBig();
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        tooBig();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: { kind?: unknown; duration_s?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return this.json(res, 400, { erro: 'JSON inválido' });
      }
      if (typeof body.kind !== 'string' || !KINDS.includes(body.kind)) return this.json(res, 400, { erro: 'tipo de sessão desconhecido' });
      const dur = body.duration_s === undefined ? this.limits.defaultDurationMs : Number(body.duration_s) * 1000;
      if (!Number.isFinite(dur) || dur <= 0) return this.json(res, 400, { erro: 'duração inválida' });
      const w = this.window.current();
      if (this.stopping || !w.open) return this.json(res, 503, { erro: 'rede fechada', motivo: this.stopping ? 'servidor encerrando' : w.reason });
      try {
        const r = this.budget.admit(body.kind as Kind, dur, this.o.clock.now());
        if (!r.ok) {
          this.log('admissao_recusada', { status: r.status, reason: r.reason });
          return this.json(res, r.status, { erro: r.reason });
        }
        this.log('admissao', { kind: body.kind });
        this.json(res, 201, {
          bilhete: r.ticket,
          bilhete_vale_ate: new Date(r.expiresAt).toISOString(),
          duracao_s: r.durationMs / 1000,
          mensagens_reservadas: r.reserved,
        });
      } catch {
        // Fail-closed: qualquer erro do banco recusa a admissão.
        this.json(res, 503, { erro: 'erro interno: fechado' });
      }
    });
  }

  private reject(socket: Duplex, status: 403 | 404 | 503, text: string): void {
    const body = JSON.stringify({ erro: text });
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Service Unavailable'}\r\n` +
        `content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/net/ws/echo') return this.reject(socket, 404, 'rota desconhecida');
      if (!this.originOk(req)) return this.reject(socket, 403, 'origem não permitida');
      const w = this.window.current();
      if (this.stopping || !w.open || w.until === null) return this.reject(socket, 503, 'rede fechada');
      const session = this.budget.redeem(url.searchParams.get('bilhete') ?? '', w.until, this.o.clock.now());
      if (!session) {
        this.log('upgrade_recusado', { status: 403, reason: 'bilhete inválido, vencido ou já usado' });
        return this.reject(socket, 403, 'bilhete inválido, vencido ou já usado');
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, session.id, session.deadline, session.reserved));
    } catch {
      this.reject(socket, 503, 'erro interno: fechado');
    }
  }

  private attach(ws: WebSocket, sessionId: string, deadline: number, reserved: number): void {
    const conn = new Conn(
      sessionId,
      deadline,
      reserved,
      { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) },
      this.o.clock,
      this.limits,
      () => ({ open: this.window.current().open && !this.stopping }),
      (c) => this.ended(c),
      (c, data) => c.send(data), // eco
    );
    this.conns.add(conn);
    ws.on('message', (data: Buffer, isBinary: boolean) => conn.onMessage(isBinary ? data : Buffer.from(data)));
    ws.on('close', () => conn.remoteClosed());
    ws.on('error', () => conn.remoteClosed());
    // Uma janela que já fechou entre o resgate e aqui encerra na hora.
    conn.check();
  }

  private ended(c: Conn): void {
    this.conns.delete(c);
    try {
      this.budget.end(c.sessionId, c.received, this.o.clock.now());
    } catch {
      // Devolução falhou: a reserva continua gasta (conservador).
    }
    this.log('sessao_encerrada', { code: c.closeCode ?? 1000, received: c.received });
  }
}
