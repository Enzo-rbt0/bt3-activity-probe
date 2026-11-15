// F2b — tela cheia (A-FS), áudio (A-AUDIO) e arquivos (A-FILE-BASIC e A-FILE-LARGE). Só lógica e
// leitura; a interface fica em ui-interactive.ts.
// Arquivos: nunca guardamos nome, conteúdo ou hash. Lemos só 3 pedaços de 2 KiB.
import type { AudioResult, FileBasicResult, FileLargeResult, FileRead, FsResult, MarkerRead, Size, TypeCategory } from '../report/types';

const SKIPPED = 'Pulado pelo usuário.';
const NOT_DONE = 'Ainda não feito.';
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

// ---------- A-FS ----------
export class FsTest {
  private entered = false;
  private exited = false;
  private error: string | null = null;
  private size: Size | null = null;
  private skipped = false;
  private tried = false;
  constructor(private enabled: boolean | null) {}
  skip(): void {
    this.skipped = true;
  }
  enteredOk(size: Size): void {
    this.tried = true;
    this.entered = true;
    this.size = size;
  }
  failed(e: unknown): void {
    this.tried = true;
    this.error = errText(e);
  }
  exitedOk(): void {
    this.exited = true;
  }
  result(): FsResult {
    const base = { fullscreen_enabled: this.enabled, entered: this.entered, exited: this.exited, error: this.error, size: this.size };
    if (this.skipped && !this.tried) return { status: 'SKIP', detail: SKIPPED, ...base };
    if (!this.tried) return { status: 'SKIP', detail: NOT_DONE, ...base };
    if (this.entered) return { status: 'AP', detail: `Tela cheia permitida (${this.size?.width}×${this.size?.height}).`, ...base };
    return {
      status: 'RP',
      detail: 'Tela cheia não permitida aqui. Limitação documentada, não bloqueio: o Discord tem modos de exibição próprios.',
      ...base,
    };
  }
}

// ---------- A-AUDIO ----------
export class AudioTest {
  private before: string | null = null;
  private after: string | null = null;
  private sampleRate: number | null = null;
  private baseLatency: number | null = null;
  private outputLatency: number | null = null;
  private heard: boolean | null = null;
  private call: { heard: boolean | null; call_voice_ok: boolean | null } | null = null;
  private skipped = false;
  private error: string | null = null;

  // Estado antes de qualquer toque: "suspended" é o esperado (política de autoplay), não reprovação.
  setBefore(state: string | null, sampleRate: number | null): void {
    this.before = state;
    this.sampleRate = sampleRate;
  }
  setAfter(state: string | null, baseLatencyS: number | null, outputLatencyS: number | null): void {
    this.after = state;
    this.baseLatency = baseLatencyS === null ? null : Math.round(baseLatencyS * 10000) / 10;
    this.outputLatency = outputLatencyS === null ? null : Math.round(outputLatencyS * 10000) / 10;
  }
  failed(e: unknown): void {
    this.error = errText(e);
  }
  answer(heard: boolean): void {
    this.heard = heard;
  }
  answerCall(heard: boolean | null, voiceOk: boolean | null): void {
    this.call = { heard: heard ?? this.call?.heard ?? null, call_voice_ok: voiceOk ?? this.call?.call_voice_ok ?? null };
  }
  skip(): void {
    this.skipped = true;
  }
  result(): AudioResult {
    const base = {
      state_before_gesture: this.before, state_after_gesture: this.after, sample_rate: this.sampleRate,
      base_latency_ms: this.baseLatency, output_latency_ms: this.outputLatency, heard: this.heard, during_call: this.call,
    };
    const callTxt = this.call
      ? ` Durante chamada: jogo ${this.call.heard === true ? 'audível' : this.call.heard === false ? 'NÃO audível' : '?'}, voz ${this.call.call_voice_ok === true ? 'ok' : this.call.call_voice_ok === false ? 'prejudicada' : '?'}.`
      : '';
    if (this.error) return { status: 'RP', detail: `O áudio não pôde ser iniciado: ${this.error}`, ...base };
    if (this.skipped && this.heard === null) return { status: 'SKIP', detail: SKIPPED, ...base };
    if (this.heard === null) return { status: 'SKIP', detail: NOT_DONE, ...base };
    const autoplay = this.before === 'suspended' ? ' (antes do toque estava suspenso: comportamento esperado)' : '';
    if (this.after === 'running' && this.heard) {
      return { status: 'AP', detail: `Tocou depois do clique e foi ouvido${autoplay}.${callTxt}`, ...base };
    }
    return {
      status: 'RP',
      detail: this.after !== 'running' ? `O áudio não iniciou depois do clique (estado: ${this.after ?? '?'}).${callTxt}` : `O áudio iniciou, mas o usuário não ouviu.${callTxt}`,
      ...base,
    };
  }
}

// ---------- Arquivos ----------
export interface BlobLike {
  size: number;
  type: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export function typeCategory(mime: string): TypeCategory {
  if (mime.startsWith('image/')) return 'imagem';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'outro';
}

// Posições de leitura sem sobreposição. Em arquivo pequeno, o pedaço encolhe para caber.
export function basicPlan(size: number): { where: FileRead['where']; offset: number; len: number }[] {
  const len = Math.min(2048, Math.floor(size / 3));
  if (len <= 0) return [];
  return [
    { where: 'inicio', offset: 0, len },
    { where: 'meio', offset: Math.floor(size / 2 - len / 2), len },
    { where: 'fim', offset: size - len, len },
  ];
}

async function timedRead(f: BlobLike, offset: number, len: number): Promise<{ buf: ArrayBuffer | null; ms: number; error: string | null }> {
  const t0 = performance.now();
  try {
    const buf = await f.slice(offset, offset + len).arrayBuffer();
    return { buf, ms: performance.now() - t0, error: null };
  } catch (e) {
    return { buf: null, ms: performance.now() - t0, error: errText(e) };
  }
}

export class FileBasicTest {
  private state: FileBasicResult = {
    status: 'SKIP', detail: NOT_DONE, picker_opened: false, cancelled: false, size: null, type_category: null, reads: [],
  };
  result(): FileBasicResult {
    return { ...this.state, reads: [...this.state.reads] };
  }
  skip(): void {
    if (this.state.reads.length === 0) this.state = { ...this.state, status: 'SKIP', detail: SKIPPED };
  }
  // Cancelar o seletor não é falha de compatibilidade.
  cancelled(): void {
    this.state = { ...this.state, status: 'SKIP', picker_opened: true, cancelled: true, detail: 'Seletor aberto e cancelado pelo usuário.' };
  }
  async run(f: BlobLike): Promise<FileBasicResult> {
    const plan = basicPlan(f.size);
    this.state = { ...this.state, picker_opened: true, cancelled: false, size: f.size, type_category: typeCategory(f.type), reads: [] };
    if (plan.length === 0) {
      this.state = { ...this.state, status: 'SKIP', detail: 'Arquivo pequeno demais (menos de 3 bytes). Escolha outro arquivo.' };
      return this.result();
    }
    const reads: FileRead[] = [];
    let error: string | null = null;
    for (const p of plan) {
      const r = await timedRead(f, p.offset, p.len);
      const ok = !!r.buf && r.buf.byteLength === p.len;
      reads.push({ where: p.where, bytes: r.buf?.byteLength ?? 0, ms: Math.round(r.ms * 10) / 10, ok });
      error = error ?? r.error;
    }
    const ok = reads.every((r) => r.ok);
    this.state = {
      ...this.state, reads,
      status: ok ? 'AP' : 'RP',
      detail: ok
        ? `Seletor abriu e as 3 leituras (início, meio e fim) vieram com o tamanho certo. Não prova nada sobre arquivo maior que 2 GiB.`
        : `A leitura do arquivo falhou${error ? `: ${error}` : ''}.`,
    };
    return this.result();
  }
}

// Arquivo sintético da F2b: marcadores "BT3PROBE-MARK:<posição>;" no início, logo depois de 2 GiB e
// no fim. Gerado por scripts/criar-arquivo-teste.ps1 (Windows) ou .mjs (Linux/macOS/CI).
export const GIB2 = 2 ** 31;
export const AFTER_2GIB = GIB2 + 2 ** 20; // 2.148.532.224
export const markerText = (offset: number) => `BT3PROBE-MARK:${offset};`;
export function largePlan(size: number): { where: MarkerRead['where']; offset: number }[] {
  return [
    { where: 'inicio', offset: 0 },
    { where: 'apos_2gib', offset: AFTER_2GIB },
    { where: 'fim', offset: size - 4096 },
  ];
}

export class FileLargeTest {
  private state: FileLargeResult = {
    status: 'SKIP', detail: `${NOT_DONE} Teste pendente: não aprova só porque o arquivo comum passou.`,
    picker_opened: false, cancelled: false, size: null, over_2gib: null, markers: [],
  };
  result(): FileLargeResult {
    return { ...this.state, markers: [...this.state.markers] };
  }
  skip(): void {
    if (this.state.markers.length === 0) {
      this.state = { ...this.state, status: 'SKIP', detail: 'Pulado pelo usuário: arquivo maior que 2 GiB fica pendente.' };
    }
  }
  cancelled(): void {
    this.state = { ...this.state, status: 'SKIP', picker_opened: true, cancelled: true, detail: 'Seletor aberto e cancelado: arquivo grande pendente.' };
  }
  async run(f: BlobLike): Promise<FileLargeResult> {
    const over = f.size > GIB2;
    this.state = { ...this.state, picker_opened: true, cancelled: false, size: f.size, over_2gib: over, markers: [] };
    if (!over) {
      this.state = { ...this.state, status: 'INV', detail: 'O arquivo escolhido não passa de 2 GiB: use o arquivo de teste com marcadores.' };
      return this.result();
    }
    const markers: MarkerRead[] = [];
    for (const p of largePlan(f.size)) {
      const r = await timedRead(f, p.offset, 2048);
      const text = r.buf ? new TextDecoder('latin1').decode(r.buf) : '';
      markers.push({ where: p.where, ok: text.startsWith(markerText(p.offset)), ms: r.buf ? Math.round(r.ms * 10) / 10 : null });
    }
    const all = markers.every((m) => m.ok);
    const none = markers.every((m) => !m.ok);
    this.state = {
      ...this.state, markers,
      // Início certo e algum outro errado = é o arquivo de teste, mas a leitura em posição alta falhou.
      status: all ? 'AP' : none ? 'INV' : 'RP',
      detail: all
        ? 'Arquivo maior que 2 GiB: os 3 marcadores (início, depois de 2³¹ bytes e fim) foram lidos na posição certa.'
        : none
          ? 'Arquivo maior que 2 GiB, mas sem os marcadores do arquivo de teste: não dá para conferir as posições.'
          : `É o arquivo de teste, mas a leitura veio errada em: ${markers.filter((m) => !m.ok).map((m) => m.where).join(', ')}.`,
    };
    return this.result();
  }
}
