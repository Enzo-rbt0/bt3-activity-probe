// A-GL2: o navegador consegue criar um contexto WebGL 2 e desenhar com ele? O port web do BT3 exige
// WebGL 2 (fato C2 da referência). Só lê capacidades e pinta 1 pixel: nada pesado.
import { clip } from '../hash';
import type { Gl2Result, Status } from '../report/types';

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

export function isSoftwareRenderer(renderer: string | null): boolean | null {
  if (renderer === null || renderer.trim() === '') return null;
  return SOFTWARE_RE.test(renderer);
}

export function classifyGl2(contextOk: boolean, drawOk: boolean, software: boolean | null): { status: Status; detail: string } {
  if (!contextOk) return { status: 'RP', detail: 'Não foi possível criar um contexto WebGL 2.' };
  if (!drawOk) return { status: 'RP', detail: 'Contexto WebGL 2 criado, mas o teste de desenho falhou.' };
  if (software === true) {
    return { status: 'INV', detail: 'WebGL 2 funciona, mas por renderização em software (sem placa de vídeo): lento demais para jogo.' };
  }
  if (software === null) {
    return { status: 'INV', detail: 'WebGL 2 funciona, mas o navegador escondeu o nome da placa de vídeo.' };
  }
  return { status: 'AP', detail: 'WebGL 2 funciona com aceleração por placa de vídeo.' };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function runGl2(doc: Document = document): Gl2Result {
  const empty: Gl2Result = {
    status: 'RP', detail: '', context_ok: false, draw_ok: false, renderer: null, vendor: null,
    software_renderer: null, max_texture_size: null, max_renderbuffer_size: null, max_samples: null,
    max_viewport_dims: null, extensions: [],
  };
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  } catch (e) {
    const c = classifyGl2(false, false, null);
    return { ...empty, ...c, detail: `${c.detail} (${String(e).slice(0, 200)})` };
  }
  if (!gl) return { ...empty, ...classifyGl2(false, false, null) };

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

    const software = isSoftwareRenderer(renderer);
    return {
      ...classifyGl2(true, drawOk, software),
      context_ok: true,
      draw_ok: drawOk,
      renderer,
      vendor,
      software_renderer: software,
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
