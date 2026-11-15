import { readUrlHints } from './env';
import { buildReport, reportFileName } from './report/build';
import type { HumanInput, Network, Report } from './report/types';
import { validateReport } from './report/validate';
import { startSdk } from './sdk';
import { classifyEnv, collectEnv, type SdkOutcome } from './tests/a-env';
import { runGl2 } from './tests/a-gl2';

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

function addRow(name: string, status: string, detail: string): void {
  const tr = document.createElement('tr');
  const cells = [name, status, detail];
  cells.forEach((text, i) => {
    const td = document.createElement('td');
    td.textContent = text;
    if (i === 1) td.className = `st st-${status}`;
    tr.appendChild(td);
  });
  $('results').querySelector('tbody')!.appendChild(tr);
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
    $('mode').textContent = sdk.ready
      ? `Dentro do Discord (${hints.platform}). SDK conectado.`
      : `Parece Discord, mas o SDK não respondeu: ${sdk.error ?? ''}`;
  }

  const env = classifyEnv(hints, sdk);
  const context = await collectEnv(hints, sdk);
  addRow('A-ENV · ambiente', env.status, env.detail);

  const gl2 = runGl2();
  addRow('A-GL2 · WebGL 2', gl2.status, gl2.renderer ? `${gl2.detail} (${gl2.renderer})` : gl2.detail);

  const durationMs = performance.now() - t0;
  const area = $<HTMLTextAreaElement>('json');
  const validEl = $('valid');
  const runId = newRunId();
  let current: Report;

  const refresh = () => {
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
      env,
      gl2,
    });
    const v = validateReport(current);
    area.value = JSON.stringify(current, null, 2);
    validEl.textContent = v.ok ? 'Relatório válido (schema bt3probe.report/1).' : `Relatório inválido: ${v.errors.join('; ')}`;
    validEl.className = `valid ${v.ok ? 'ok' : 'bad'}`;
    document.body.dataset.reportValid = String(v.ok);
  };
  refresh();
  $('human').addEventListener('input', refresh);
  $('human').addEventListener('change', refresh);

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
