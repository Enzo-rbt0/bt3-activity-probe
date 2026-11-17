import { readUrlHints } from './env';
import { ASYNCIFY_WASM, CORE_WASM, FEATURE_WASM, JSPI_WASM } from './generated/wasm-modules';
import { buildReport, reportFileName } from './report/build';
import type { Basic, HumanInput, Network, PersistResult, Report, Tests } from './report/types';
import { validateReport } from './report/validate';
import { startSdk } from './sdk';
import { classifyEnv, collectEnv, type SdkOutcome } from './tests/a-env';
import { readEmccVersion, runAsyncifyCore, runEmcc, runJspiCore } from './tests/a-async';
import { runGl2 } from './tests/a-gl2';
import { PersistTest, runIdbReadWrite } from './tests/a-idb';
import { LayoutWatcher, VisWatcher } from './tests/a-layout';
import { mountInteractive } from './ui-interactive';
import { mountNet } from './ui-net';
import { CspCollector, fromB64, runBench, runWasmEmbed, runWasmFeat, runWasmUrl } from './tests/a-wasm';

// Começa a ouvir bloqueios de CSP antes de qualquer teste.
const csp = new CspCollector();
csp.listen(window);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function newRunId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function readHuman(): HumanInput {
  const f = new FormData($<HTMLFormElement>('human'));
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const voice = s('voice_call_active');
  return {
    device_label: s('device_label'),
    os_label: s('os_label'),
    network: (s('network') || 'nao-informado') as Network,
    voice_call_active: voice === 'sim' ? true : voice === 'nao' ? false : null,
    notes: s('notes'),
  };
}

const LABELS: Record<keyof Tests, string> = {
  'A-ENV': 'A-ENV · ambiente',
  'A-GL2': 'A-GL2 · WebGL 2',
  'A-WASM-EMBED': 'A-WASM-EMBED · WebAssembly embutido',
  'A-WASM-URL': 'A-WASM-URL · .wasm por URL',
  'A-CSP': 'A-CSP · bloqueios de segurança',
  'A-WASM-FEAT': 'A-WASM-FEAT · recursos extras',
  'A-JSPI-CORE': 'A-JSPI-CORE · JSPI (navegador)',
  'A-ASYNCIFY-CORE': 'A-ASYNCIFY-CORE · Asyncify (navegador)',
  'A-JSPI-EMCC': 'A-JSPI-EMCC · JSPI (Emscripten)',
  'A-ASYNCIFY-EMCC': 'A-ASYNCIFY-EMCC · Asyncify (Emscripten)',
  'A-IDB': 'A-IDB · gravar e ler',
  'A-IDB-PERSIST': 'A-IDB-PERSIST · save entre sessões',
  'A-LAYOUT': 'A-LAYOUT · tela',
  'A-VIS': 'A-VIS · minimizar e voltar',
  'I-BENCH': 'I-BENCH · conta (informativo)',
  'A-KEY': 'A-KEY · teclado',
  'A-PAD': 'A-PAD · controle',
  'A-TOUCH': 'A-TOUCH · toque',
  'A-FS': 'A-FS · tela cheia',
  'A-AUDIO': 'A-AUDIO · áudio',
  'A-FILE-BASIC': 'A-FILE-BASIC · arquivo comum',
  'A-FILE-LARGE': 'A-FILE-LARGE · arquivo > 2 GiB',
  'N-HTTP': 'N-HTTP · servidor responde',
  'N-PATH': 'N-PATH · caminho pelo Discord',
  'N-WS-OPEN': 'N-WS-OPEN · conexões WebSocket',
};
const GROUPS: [string, (keyof Tests)[]][] = [
  ['Ambiente e gráfico', ['A-ENV', 'A-GL2']],
  ['WebAssembly', ['A-WASM-EMBED', 'A-WASM-URL', 'A-CSP', 'A-WASM-FEAT', 'I-BENCH']],
  ['Pausar e retomar (JSPI / Asyncify)', ['A-JSPI-CORE', 'A-ASYNCIFY-CORE', 'A-JSPI-EMCC', 'A-ASYNCIFY-EMCC']],
  ['Armazenamento', ['A-IDB', 'A-IDB-PERSIST']],
  ['Tela', ['A-LAYOUT', 'A-VIS']],
  ['Interação (F2b)', ['A-KEY', 'A-PAD', 'A-TOUCH', 'A-FS', 'A-AUDIO', 'A-FILE-BASIC', 'A-FILE-LARGE']],
  ['Rede (F3a)', ['N-HTTP', 'N-PATH', 'N-WS-OPEN']],
];

function renderTable(tests: Tests): void {
  const tbody = $('results').querySelector('tbody')!;
  tbody.textContent = '';
  for (const [group, keys] of GROUPS) {
    const g = document.createElement('tr');
    g.className = 'group';
    const gtd = document.createElement('td');
    gtd.colSpan = 3;
    gtd.textContent = group;
    g.appendChild(gtd);
    tbody.appendChild(g);
    for (const k of keys) {
      const t = tests[k] as Basic & { renderer?: string | null };
      const tr = document.createElement('tr');
      const detail = k === 'A-GL2' && t.renderer ? `${t.detail} (${t.renderer})` : t.detail;
      [LABELS[k], t.status, detail].forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i === 1) td.className = `st st-${t.status}`;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }
}

async function copyText(text: string, area: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // O iframe do Discord pode bloquear a área de transferência; tenta o método antigo.
    area.focus();
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const t0 = performance.now();
  $('build').textContent = `v${__PROBE_VERSION__} · ${__PROBE_GIT_SHA__}`;

  const hints = readUrlHints(window.location.search);
  $('mode').textContent =
    hints.mode === 'discord' ? `Parece Discord (${hints.platform}). Conectando ao SDK…` : 'Fora do Discord (modo standalone).';

  let sdk: SdkOutcome | null = null;
  if (hints.mode === 'discord') {
    sdk = await startSdk();
  }
  const context = await collectEnv(hints, sdk);
  const env = classifyEnv(hints, sdk, context.discord_client);
  const where = { 'desktop-app': 'Discord Desktop', web: 'Discord Web', mobile: 'Discord no celular' } as const;
  if (sdk) {
    $('mode').textContent = sdk.ready
      ? `Dentro do ${context.discord_client ? where[context.discord_client] : 'Discord'}. SDK conectado.`
      : `Parece Discord, mas o SDK não respondeu: ${sdk.error ?? ''}`;
  }

  let refresh = () => {};
  const layout = new LayoutWatcher(window, () => refresh());
  const vis = new VisWatcher(window, () => refresh());
  const interactive = mountInteractive($('interactive'), () => refresh());
  const net = mountNet($('net'), hints.mode, () => refresh());

  const gl2 = runGl2();

  // WebAssembly
  const coreBytes = fromB64(CORE_WASM);
  const embed = await runWasmEmbed(coreBytes);
  const wasmUrl = await runWasmUrl(new URL('./wasm/probe-url.wasm', document.baseURI).href);
  const feat = runWasmFeat(FEATURE_WASM);
  const bench = runBench(embed.exports);

  // Pausar e retomar
  const jspiCore = await runJspiCore(fromB64(JSPI_WASM));
  const asyncifyCore = await runAsyncifyCore(fromB64(ASYNCIFY_WASM));
  const emccBase = new URL('./emcc/', document.baseURI).href;
  const emccVersion = await readEmccVersion(emccBase);
  const jspiEmcc = await runEmcc('jspi', emccBase, emccVersion);
  const asyncifyEmcc = await runEmcc('asyncify', emccBase, emccVersion);

  // Armazenamento
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const rw = await runIdbReadWrite(idb, navigator);
  const persist = new PersistTest(idb, context.storage_context);
  let persistState: PersistResult = await persist.check();

  const durationMs = performance.now() - t0;
  const area = $<HTMLTextAreaElement>('json');
  const validEl = $('valid');
  const runId = newRunId();
  let current: Report;

  const pStatus = $('persist-status');
  const pWrite = $<HTMLButtonElement>('persist-write');
  const pDelete = $<HTMLButtonElement>('persist-delete');
  const pMissing = $<HTMLButtonElement>('persist-missing');
  const persistUi = () => {
    pStatus.textContent = `${persistState.status} · ${persistState.detail}`;
    pStatus.className = `persist-status st-${persistState.status}`;
    const ok = !!idb && persistState.status !== 'RP';
    pWrite.disabled = !ok || persistState.state_now === 'pending';
    pDelete.disabled = persistState.state_now !== 'pending';
    pMissing.disabled = !persist.canReportMissing();
  };

  refresh = () => {
    const tests: Tests = {
      'A-ENV': env,
      'A-GL2': gl2,
      'A-WASM-EMBED': embed.result,
      'A-WASM-URL': wasmUrl,
      'A-CSP': csp.result(),
      'A-WASM-FEAT': feat,
      'A-JSPI-CORE': jspiCore,
      'A-ASYNCIFY-CORE': asyncifyCore,
      'A-JSPI-EMCC': jspiEmcc,
      'A-ASYNCIFY-EMCC': asyncifyEmcc,
      'A-IDB': rw.result,
      'A-IDB-PERSIST': persistState,
      'A-LAYOUT': layout.result(),
      'A-VIS': vis.result(),
      'I-BENCH': bench,
      ...interactive(),
      ...net(),
    };
    current = buildReport({
      version: __PROBE_VERSION__,
      gitSha: __PROBE_GIT_SHA__,
      builtAt: __PROBE_BUILT_AT__,
      sdkVersion: sdk?.sdkVersion ?? __SDK_VERSION__,
      runId,
      startedAt: startedAt.toISOString(),
      durationMs,
      tzOffsetMin: -startedAt.getTimezoneOffset(),
      context,
      human: readHuman(),
      tests,
      // O teste imediato grava e apaga 1 KB. Um marcador pendente de persistência é intencional
      // (aparece em A-IDB-PERSIST.marker_pending) e é apagado na próxima abertura.
      cleanup: { needed: true, performed: rw.deleted },
    });
    renderTable(tests);
    persistUi();
    const v = validateReport(current);
    area.value = JSON.stringify(current, null, 2);
    validEl.textContent = v.ok ? 'Relatório válido (schema bt3probe.report/5).' : `Relatório inválido: ${v.errors.join('; ')}`;
    validEl.className = `valid ${v.ok ? 'ok' : 'bad'}`;
    document.body.dataset.reportValid = String(v.ok);
  };
  refresh();
  $('human').addEventListener('input', refresh);
  $('human').addEventListener('change', refresh);

  pWrite.addEventListener('click', async () => {
    persistState = await persist.write();
    refresh();
  });
  pDelete.addEventListener('click', async () => {
    persistState = await persist.remove();
    refresh();
  });
  pMissing.addEventListener('click', () => {
    persistState = persist.reportMissing();
    refresh();
  });

  const dl = $<HTMLButtonElement>('download');
  const cp = $<HTMLButtonElement>('copy');
  dl.disabled = false;
  cp.disabled = false;
  dl.addEventListener('click', () => {
    const blob = new Blob([area.value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reportFileName(current);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  cp.addEventListener('click', async () => {
    const ok = await copyText(area.value, area);
    cp.textContent = ok ? 'Copiado!' : 'Selecione e copie o texto abaixo';
    setTimeout(() => (cp.textContent = 'Copiar JSON'), 2500);
  });
  document.body.dataset.probeDone = 'true';
}

main().catch((e) => {
  $('mode').textContent = `Erro inesperado na sonda: ${String(e)}`;
  document.body.dataset.probeDone = 'error';
});
