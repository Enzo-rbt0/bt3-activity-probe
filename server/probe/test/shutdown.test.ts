// T10: encerramento por sinal registra falhas e só sai com 0 quando stop() termina bem.
import { describe, expect, it } from 'vitest';
import { makeLogger } from '../src/log.js';
import { shutdown } from '../src/shutdown.js';

function setup() {
  const logs: string[] = [];
  const codes: number[] = [];
  return { logs, codes, log: makeLogger((l) => logs.push(l)), exit: (c: number) => void codes.push(c) };
}

describe('T10 — encerramento por SIGTERM', () => {
  it('stop() ok → saída 0', async () => {
    const t = setup();
    await shutdown(async () => undefined, t.log, t.exit);
    expect(t.codes).toEqual([0]);
    expect(t.logs.map((l) => JSON.parse(l).event)).toEqual(['encerrado']);
  });

  it('stop() rejeita → falha registrada e saída 1', async () => {
    const t = setup();
    await shutdown(async () => Promise.reject(new TypeError('x')), t.log, t.exit);
    expect(t.codes).toEqual([1]);
    expect(JSON.parse(t.logs[0]!)).toEqual({ event: 'encerramento_falhou', reason: 'TypeError' });
  });

  it('stop() não termina → tempo esgotado registrado e saída 1', async () => {
    const t = setup();
    await shutdown(() => new Promise<void>(() => undefined), t.log, t.exit, 50);
    expect(t.codes).toEqual([1]);
    expect(JSON.parse(t.logs[0]!)).toEqual({ event: 'encerramento_falhou', reason: 'tempo esgotado' });
  });
});
