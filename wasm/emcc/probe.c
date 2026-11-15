// Programa C mínimo próprio (nada de jogo) para testar o runtime gerado pelo Emscripten.
// probe_run chama uma função JavaScript assíncrona (espera 10 ms e devolve x + 1) e dobra o resultado.
// Com x = 20, o resultado certo é 42. Compilado duas vezes: com -sJSPI e com -sASYNCIFY.
#include <emscripten.h>

EM_ASYNC_JS(int, probe_wait_value, (int x), {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return x + 1;
});

EMSCRIPTEN_KEEPALIVE int probe_run(int x) {
  return probe_wait_value(x) * 2;
}
