import { defineConfig } from 'vitest/config';

// Só os testes da sonda. Evita varrer o cache do Emscripten (emsdk-cache/) que a CI cria na raiz.
export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts'],
  },
});
