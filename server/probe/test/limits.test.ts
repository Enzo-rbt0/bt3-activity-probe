// T15 — tetos configuráveis pela VM (arquivo /etc/bt3probe/limites.json + script ops/bt3probe-limites).
// Regra central: um erro de configuração nunca deixa o servidor MAIS permissivo que o padrão do código.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget.js';
import { CHAVES, loadLimits, parseLimits } from '../src/limits.js';
import { admit, harness, http, tick, waitFor, type Harness } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'ops/bt3probe-limites');
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-l-'));

describe('T15 — parseLimits (validação)', () => {
  it('arquivo válido muda só as chaves presentes; o resto fica no padrão', () => {
    const p = parseLimits(JSON.stringify({ mensagens_dia: 300_000, admissoes_dia: 60 }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.limits).toEqual({ ...DEFAULT_LIMITS, maxReservedPerDay: 300_000, maxAdmissionsPerDay: 60 });
    expect(p.valores).toEqual({ mensagens_dia: 300_000, admissoes_dia: 60 });
    expect(parseLimits('{}')).toEqual({ ok: true, limits: DEFAULT_LIMITS, valores: {} });
  });

  it('cada chave vai para o campo certo (duração em segundos vira ms)', () => {
    const p = parseLimits(JSON.stringify({ conexoes_simultaneas: 6, mensagens_por_segundo: 200, duracao_maxima_s: 300 }));
    expect(p.ok && p.limits).toEqual({ ...DEFAULT_LIMITS, maxConcurrent: 6, maxRatePerSec: 200, maxDurationMs: 300_000 });
  });

  it('aceita exatamente os extremos de cada chave e recusa um a mais ou a menos', () => {
    for (const [chave, r] of Object.entries(CHAVES)) {
      expect(parseLimits(JSON.stringify({ [chave]: r.min })).ok, `${chave}=${r.min}`).toBe(true);
      expect(parseLimits(JSON.stringify({ [chave]: r.max })).ok, `${chave}=${r.max}`).toBe(true);
      expect(parseLimits(JSON.stringify({ [chave]: r.min - 1 })).ok, `${chave}=${r.min - 1}`).toBe(false);
      expect(parseLimits(JSON.stringify({ [chave]: r.max + 1 })).ok, `${chave}=${r.max + 1}`).toBe(false);
    }
  });

  it('tetos absolutos são os combinados', () => {
    expect(Object.fromEntries(Object.entries(CHAVES).map(([k, r]) => [k, [r.min, r.max]]))).toEqual({
      mensagens_dia: [1, 1_000_000],
      admissoes_dia: [1, 200],
      conexoes_simultaneas: [1, 8],
      mensagens_por_segundo: [1, 240],
      duracao_maxima_s: [1, 600],
    });
  });

  it('recusa JSON inválido, formato errado, chave desconhecida e valores não inteiros', () => {
    for (const t of ['{', '', 'null', '[]', '42', '"x"']) expect(parseLimits(t).ok, t).toBe(false);
    for (const v of [3.5, '300000', true, null, Number.MAX_SAFE_INTEGER + 2, -1, 0]) {
      expect(parseLimits(JSON.stringify({ mensagens_dia: v })).ok, String(v)).toBe(false);
    }
    expect(parseLimits(JSON.stringify({ mensagens_dia: 1000, bytes_por_mensagem: 128 }))).toEqual({ ok: false, motivo: 'chave desconhecida: bytes_por_mensagem' });
    expect(parseLimits(JSON.stringify({ __proto__: 1, constructor: 2 })).ok).toBe(false);
    expect(parseLimits('{"toString":5}').ok).toBe(false);
  });
});

describe('T15 — loadLimits (fail-safe)', () => {
  it('sem arquivo: padrão do código, sem aviso', () => {
    const enoent = () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    };
    expect(loadLimits('/x', enoent)).toEqual({ limits: DEFAULT_LIMITS, source: { origem: 'padrao', motivo: null } });
  });

  it('arquivo ilegível: padrão do código, com aviso', () => {
    const eacces = () => {
      throw Object.assign(new Error('x'), { code: 'EACCES' });
    };
    expect(loadLimits('/x', eacces)).toEqual({ limits: DEFAULT_LIMITS, source: { origem: 'padrao', motivo: 'arquivo de limites ilegível' } });
  });

  it('um único valor ruim invalida o arquivo INTEIRO (nunca fica mais permissivo)', () => {
    const r = loadLimits('/x', () => JSON.stringify({ mensagens_dia: 300_000, admissoes_dia: 9999 }));
    expect(r.limits).toBe(DEFAULT_LIMITS);
    expect(r.source).toEqual({ origem: 'padrao', motivo: 'arquivo de limites ignorado: admissoes_dia: fora de 1..200' });
  });

  it('arquivo válido: origem "arquivo"', () => {
    const r = loadLimits('/x', () => '{"mensagens_dia":300000}');
    expect(r.limits.maxReservedPerDay).toBe(300_000);
    expect(r.source).toEqual({ origem: 'arquivo', motivo: null });
  });
});

describe('T15 — efeito no servidor', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('os tetos do arquivo valem na admissão (31ª admissão aceita com admissoes_dia = 60)', async () => {
    const p = parseLimits('{"admissoes_dia":60,"conexoes_simultaneas":8}');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    h = await harness({ limits: p.limits });
    for (let i = 0; i < 31; i++) {
      const r = await admit(h.port, 1);
      expect(r.status, `admissão ${i + 1}`).toBe(201);
      h.clock.advance(31_000); // bilhete não usado vence (30 s) e libera a vaga
    }
  });
});

describe('T15 — processo real lê o arquivo na inicialização', () => {
  const start = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'dist/main.js')], {
      env: { PATH: process.env.PATH, BT3PROBE_PORT: '0', BT3PROBE_DB: ':memory:', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    child.stdout.on('data', (d: Buffer) => lines.push(...d.toString().trim().split('\n')));
    await waitFor(() => lines.some((l) => l.includes('"start"')), 10_000);
    const port = JSON.parse(lines.find((l) => l.includes('"start"'))!).port as number;
    return { child, lines, port };
  };

  it('arquivo válido → tetos do arquivo no health; inválido → padrão + aviso; sem arquivo → padrão', async () => {
    const dir = tmp();
    const arq = join(dir, 'limites.json');
    try {
      writeFileSync(arq, '{"mensagens_dia":300000,"admissoes_dia":60}');
      let p = await start({ BT3PROBE_LIMITS_FILE: arq, BT3PROBE_WINDOW_FILE: join(dir, 'janela') });
      try {
        const b = (await http(p.port, 'GET', '/net/health')).body;
        expect(b.tetos.mensagens_reservadas_por_dia).toBe(300_000);
        expect(b.tetos.admissoes_por_dia).toBe(60);
        expect(b.tetos.sessoes_simultaneas).toBe(DEFAULT_LIMITS.maxConcurrent);
        expect(b.tetos_origem).toBe('arquivo');
        expect(b.tetos_aviso).toBeNull();
        expect(b.aberto).toBe(false); // tetos não abrem nada
        expect(p.lines).toContain('{"event":"limites","reason":"arquivo"}');
      } finally {
        p.child.kill('SIGKILL');
      }

      writeFileSync(arq, '{"mensagens_dia":5000000}');
      p = await start({ BT3PROBE_LIMITS_FILE: arq, BT3PROBE_WINDOW_FILE: join(dir, 'janela') });
      try {
        const b = (await http(p.port, 'GET', '/net/health')).body;
        expect(b.tetos.mensagens_reservadas_por_dia).toBe(DEFAULT_LIMITS.maxReservedPerDay);
        expect(b.tetos_origem).toBe('padrao');
        expect(b.tetos_aviso).toBe('arquivo de limites ignorado: mensagens_dia: fora de 1..1000000');
      } finally {
        p.child.kill('SIGKILL');
      }

      rmSync(arq);
      p = await start({ BT3PROBE_LIMITS_FILE: arq, BT3PROBE_WINDOW_FILE: join(dir, 'janela') });
      try {
        const b = (await http(p.port, 'GET', '/net/health')).body;
        expect(b.tetos.admissoes_por_dia).toBe(DEFAULT_LIMITS.maxAdmissionsPerDay);
        expect(b.tetos_origem).toBe('padrao');
        expect(b.tetos_aviso).toBeNull();
        expect(p.lines).toContain('{"event":"limites","reason":"padrao"}');
      } finally {
        p.child.kill('SIGKILL');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T15 — script ops/bt3probe-limites (processo real, sem reiniciar serviço)', () => {
  const runner = (arq: string, extra: Record<string, string> = {}) => (...args: string[]) =>
    spawnSync('sh', [script, ...args], {
      env: { PATH: process.env.PATH, BT3PROBE_LIMITS_FILE: arq, BT3PROBE_DIST: join(root, 'dist'), BT3PROBE_NO_RESTART: '1', BT3PROBE_PORT: '1', ...extra },
      encoding: 'utf8',
    });

  it('definir / remover / padrao gravam JSON válido, 0644, e validam com o próprio código do servidor', () => {
    const dir = tmp();
    const arq = join(dir, 'limites.json');
    const run = runner(arq);
    try {
      expect(run('definir', 'mensagens_dia', '300000').status).toBe(0);
      expect(run('definir', 'admissoes_dia', '60').status).toBe(0);
      expect(JSON.parse(readFileSync(arq, 'utf8'))).toEqual({ mensagens_dia: 300_000, admissoes_dia: 60 });
      expect(statSync(arq).mode & 0o777).toBe(0o644);
      expect(parseLimits(readFileSync(arq, 'utf8')).ok).toBe(true);

      expect(run('remover', 'mensagens_dia').status).toBe(0);
      expect(JSON.parse(readFileSync(arq, 'utf8'))).toEqual({ admissoes_dia: 60 });
      expect(run('remover', 'admissoes_dia').status).toBe(0);
      expect(existsSync(arq)).toBe(false); // vazio = sem arquivo

      expect(run('definir', 'conexoes_simultaneas', '6').status).toBe(0);
      expect(run('padrao').status).toBe(0);
      expect(existsSync(arq)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recusa valor acima do teto absoluto, chave desconhecida, decimal e texto, sem tocar no arquivo', () => {
    const dir = tmp();
    const arq = join(dir, 'limites.json');
    const run = runner(arq);
    try {
      expect(run('definir', 'mensagens_dia', '300000').status).toBe(0);
      const antes = readFileSync(arq, 'utf8');
      const casos: [string[], number, RegExp][] = [
        [['definir', 'mensagens_dia', '3000000'], 1, /fora de 1\.\.1000000/],
        [['definir', 'admissoes_dia', '0'], 1, /fora de 1\.\.200/],
        [['definir', 'bytes_por_mensagem', '128'], 1, /chave desconhecida/],
        [['definir', 'mensagens_dia', '3.5'], 2, /inteiro/],
        [['definir', 'mensagens_dia', '1e6'], 2, /inteiro/],
        [['definir', 'mensagens_dia', '-5'], 2, /inteiro/],
        [['definir', 'mensagens_dia'], 2, /uso:/],
        [['qualquer'], 2, /uso:/],
      ];
      for (const [args, code, msg] of casos) {
        const r = run(...args);
        expect(r.status, args.join(' ')).toBe(code);
        expect(r.stderr, args.join(' ')).toMatch(msg);
        expect(readFileSync(arq, 'utf8'), args.join(' ')).toBe(antes);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arquivo atual inválido: definir recusa e manda usar "padrao"', () => {
    const dir = tmp();
    const arq = join(dir, 'limites.json');
    try {
      writeFileSync(arq, '{ruim');
      const r = runner(arq)('definir', 'admissoes_dia', '60');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Rode "padrao"/);
      expect(readFileSync(arq, 'utf8')).toBe('{ruim');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mostrar lê os tetos em uso do serviço real (porta local)', async () => {
    const dir = tmp();
    const arq = join(dir, 'limites.json');
    writeFileSync(arq, '{"mensagens_dia":300000}');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'dist/main.js')], {
      env: { PATH: process.env.PATH, BT3PROBE_PORT: '0', BT3PROBE_DB: ':memory:', BT3PROBE_LIMITS_FILE: arq, BT3PROBE_WINDOW_FILE: join(dir, 'janela') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    child.stdout.on('data', (d: Buffer) => lines.push(...d.toString().trim().split('\n')));
    try {
      await waitFor(() => lines.some((l) => l.includes('"start"')), 10_000);
      const port = String(JSON.parse(lines.find((l) => l.includes('"start"'))!).port);
      await tick(50);
      const r = await new Promise<{ status: number | null; out: string }>((res) => {
        const c = spawn('sh', [script, 'mostrar'], { env: { PATH: process.env.PATH, BT3PROBE_LIMITS_FILE: arq, BT3PROBE_DIST: join(root, 'dist'), BT3PROBE_PORT: port } });
        let out = '';
        c.stdout.on('data', (d: Buffer) => (out += d.toString()));
        c.on('exit', (status) => res({ status, out }));
      });
      expect(r.status).toBe(0);
      expect(r.out).toContain('tetos em uso (origem: arquivo)');
      expect(r.out).toContain('mensagens_reservadas_por_dia: 300000');
      expect(r.out).toContain('rede: fechada');
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
