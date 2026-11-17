// Tetos configuráveis pela VM, sem mudar código. Arquivo JSON gravado pelo script ops/bt3probe-limites
// (via SSH, por quem opera a VM) e lido UMA vez, na inicialização do processo:
//   {"mensagens_dia":300000,"admissoes_dia":60}
// Só as 5 chaves de CHAVES podem aparecer; as ausentes ficam no padrão do código (DEFAULT_LIMITS).
// Fail-safe: arquivo ilegível, JSON inválido, chave desconhecida, valor não inteiro, abaixo do mínimo ou
// acima do teto absoluto → o arquivo INTEIRO é ignorado e valem os padrões do código. Um erro de
// configuração nunca deixa o servidor mais permissivo do que o padrão.
// O resto (64 B por mensagem, bilhete de 30 s, margem, inatividade, janela fechada por padrão) é fixo.
import { readFileSync } from 'node:fs';
import { DEFAULT_LIMITS, type Limits } from './budget.js';

type Campo = 'maxReservedPerDay' | 'maxAdmissionsPerDay' | 'maxConcurrent' | 'maxRatePerSec' | 'maxDurationMs';
interface Regra { campo: Campo; min: number; max: number; escala: number }

// Tetos ABSOLUTOS: o arquivo nunca passa disso (protege contra erro de digitação, como um zero a mais).
export const CHAVES: Readonly<Record<string, Regra>> = {
  mensagens_dia: { campo: 'maxReservedPerDay', min: 1, max: 1_000_000, escala: 1 },
  admissoes_dia: { campo: 'maxAdmissionsPerDay', min: 1, max: 200, escala: 1 },
  conexoes_simultaneas: { campo: 'maxConcurrent', min: 1, max: 8, escala: 1 },
  mensagens_por_segundo: { campo: 'maxRatePerSec', min: 1, max: 240, escala: 1 },
  duracao_maxima_s: { campo: 'maxDurationMs', min: 1, max: 600, escala: 1000 },
};

export type LimitsSource = { origem: 'arquivo' | 'padrao'; motivo: string | null };
export type ParsedLimits = { ok: true; limits: Limits; valores: Record<string, number> } | { ok: false; motivo: string };

export function parseLimits(text: string, base: Limits = DEFAULT_LIMITS): ParsedLimits {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, motivo: 'JSON inválido' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, motivo: 'o arquivo precisa ser um objeto JSON' };
  const limits: Limits = { ...base };
  const valores: Record<string, number> = {};
  for (const [chave, v] of Object.entries(raw)) {
    const r = Object.hasOwn(CHAVES, chave) ? CHAVES[chave] : undefined;
    if (!r) return { ok: false, motivo: `chave desconhecida: ${chave.slice(0, 40)}` };
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, motivo: `${chave}: precisa ser um número inteiro` };
    if (v < r.min || v > r.max) return { ok: false, motivo: `${chave}: fora de ${r.min}..${r.max}` };
    limits[r.campo] = v * r.escala;
    valores[chave] = v;
  }
  return { ok: true, limits, valores };
}

// Leitura na inicialização. Arquivo ausente é o caso normal (padrão do código).
export function loadLimits(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): { limits: Limits; source: LimitsSource } {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    const ausente = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
    return { limits: DEFAULT_LIMITS, source: { origem: 'padrao', motivo: ausente ? null : 'arquivo de limites ilegível' } };
  }
  const p = parseLimits(text);
  if (!p.ok) return { limits: DEFAULT_LIMITS, source: { origem: 'padrao', motivo: `arquivo de limites ignorado: ${p.motivo}` } };
  return { limits: p.limits, source: { origem: 'arquivo', motivo: null } };
}
