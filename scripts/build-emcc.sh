#!/usr/bin/env bash
# Compila wasm/emcc/probe.c com Emscripten em duas variantes (JSPI e Asyncify) para
# apps/probe/public/emcc/ (fora do git). O Emscripten não fica instalado no ambiente do agente:
# quem compila é o GitHub Actions (versão fixa no workflow). Sem emcc, o script só avisa, e a
# sonda marca os testes EMCC como SKIP — a não ser que REQUIRE_EMCC=1 (CI), quando falha.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=apps/probe/public/emcc
if ! command -v emcc >/dev/null 2>&1; then
  if [ "${REQUIRE_EMCC:-0}" = "1" ]; then
    echo "ERRO: emcc não encontrado e REQUIRE_EMCC=1" >&2
    exit 1
  fi
  echo "aviso: emcc não encontrado; testes EMCC vão aparecer como SKIP nesta build"
  rm -rf "$OUT"
  exit 0
fi
mkdir -p "$OUT"
COMMON=(
  wasm/emcc/probe.c -O2
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web
  -sDYNAMIC_EXECUTION=0
  -sEXPORTED_FUNCTIONS=_probe_run -sEXPORTED_RUNTIME_METHODS=ccall
  -sINITIAL_MEMORY=16MB
)
emcc "${COMMON[@]}" -sJSPI=1 -sJSPI_EXPORTS=probe_run -o "$OUT/probe-jspi.mjs"
emcc "${COMMON[@]}" -sASYNCIFY=1 -o "$OUT/probe-asyncify.mjs"
emcc --version | head -1 > "$OUT/emcc-version.txt"
ls -la "$OUT"
