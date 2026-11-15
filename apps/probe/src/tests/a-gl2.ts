// A-GL2: o navegador consegue criar um contexto WebGL 2 e desenhar com ele? O port web do BT3 exige
// WebGL 2 (fato C2 da referência). Só lê capacidades e pinta 1 pixel: nada pesado.
import { clip } from '../hash';
import type { Gl2Result, Status } from '../report/types';

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
// Nomes genéricos que alguns navegadores devolvem para esconder a placa de vídeo (achado da F2a:
// o Brave devolve só "Brave"). Com eles não dá para saber se há aceleração.
const MASKED_RE = /^\s*(brave|webkit webgl|webkit|mozilla|google inc\.?|generic renderer|disabled|unknown)\s*$/i;

// Só nomes de fabricantes/linhas de placa de vídeo conhecidos contam como "confirmed" (revisão do
// PR #3). Nome não reconhecido = "unknown". Mesmo um nome reconhecido é evidência indicativa, não
// medição: o desempenho real é medido na F3.
const HARDWARE_RE =
  /nvidia|geforce|quadro|\brtx\b|\bgtx\b|\bamd\b|radeon|\bati\b|intel\(r\)|intel.*(uhd|iris|hd graphics|arc)|\badreno\b|\bmali\b|powervr|apple (gpu|m\d)|xclipse|immortalis|tegra|vivante/i;

export type GpuAcceleration = 'confirmed' | 'software' | 'unknown' | 'none';

// Duas perguntas separadas (revisão da F2b): o WebGL 2 funciona? A aceleração por placa de vídeo
// está confirmada? Esconder o nome da placa não quer dizer que o WebGL 2 falhou.
export function gpuAcceleration(renderer: string | null): Exclude<GpuAcceleration, 'none'> {
  if (renderer === null || renderer.trim() === '' || MASKED_RE.test(renderer)) return 'unknown';
  if (SOFTWARE_RE.test(renderer)) return 'software';
  return HARDWARE_RE.test(renderer) ? 'confirmed' : 'unknown';
}

export function isSoftwareRenderer(renderer: string | null): boolean | null {
  const g = gpuAcceleration(renderer);
  return g === 'unknown' ? null : g === 'software';
}

export function classifyGl2(contextOk: boolean, drawOk: boolean, accel: GpuAcceleration): { status: Status; detail: string } {
  if (!contextOk) return { status: 'RP', detail: 'Não foi possível criar um contexto WebGL 2.' };
  if (!drawOk) return { status: 'RP', detail: 'Contexto WebGL 2 criado, mas o teste de desenho falhou.' };
  if (accel === 'software') {
    return {
      status: 'INV',
      detail:
        'WebGL 2 funciona, mas por renderização em software (sem placa de vídeo): lento demais para jogo. ' +
        'No Discord: Configurações → Avançado → Aceleração de hardware.',
    };
  }
  if (accel === 'unknown') {
    return {
      status: 'AP',
      detail: 'WebGL 2 funciona. Aceleração por placa de vídeo NÃO confirmada: o nome da placa está escondido ou não é reconhecido.',
    };
  }
  return { status: 'AP', detail: 'WebGL 2 funciona; o nome da placa indica aceleração por hardware (indicativo, não medido).' };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function runGl2(doc: Document = document): Gl2Result {
  const empty: Gl2Result = {
    status: 'RP', detail: '', context_ok: false, draw_ok: false, renderer: null, vendor: null,
    software_renderer: null, gpu_acceleration_status: 'none', max_texture_size: null, max_renderbuffer_size: null, max_samples: null,
    max_viewport_dims: null, extensions: [],
  };
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  } catch (e) {
    const c = classifyGl2(false, false, 'none');
    return { ...empty, ...c, detail: `${c.detail} (${String(e).slice(0, 200)})` };
  }
  if (!gl) return { ...empty, ...classifyGl2(false, false, 'none') };

  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = clip(String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '') || null);
    const vendor = clip(String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? '') || null);
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;

    gl.viewport(0, 0, 4, 4);
    gl.clearColor(0, 1, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const drawOk = gl.getError() === gl.NO_ERROR && px[0] === 0 && px[1] === 255 && px[2] === 0 && px[3] === 255;

    const accel = gpuAcceleration(renderer);
    return {
      ...classifyGl2(true, drawOk, accel),
      context_ok: true,
      draw_ok: drawOk,
      renderer,
      vendor,
      software_renderer: isSoftwareRenderer(renderer),
      gpu_acceleration_status: accel,
      max_texture_size: num(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      max_renderbuffer_size: num(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
      max_samples: num(gl.getParameter(gl.MAX_SAMPLES)),
      max_viewport_dims: dims && dims.length >= 2 ? [Number(dims[0]), Number(dims[1])] : null,
      extensions: (gl.getSupportedExtensions() ?? []).slice(0, 200),
    };
  } catch (e) {
    return { ...empty, status: 'ERRO', context_ok: true, detail: `Erro lendo WebGL 2: ${String(e).slice(0, 200)}` };
  } finally {
    // Devolve a placa de vídeo na hora, em vez de esperar o coletor de lixo.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
