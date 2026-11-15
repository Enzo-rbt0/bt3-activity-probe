// Log mínimo. Só eventos e campos de uma lista fechada: nunca IP, URL (que pode conter bilhete),
// user agent, cabeçalhos, instance_id ou qualquer ID do Discord.
export type LogFields = Partial<Record<'kind' | 'code' | 'reason' | 'status' | 'received' | 'closed' | 'port', string | number | boolean>>;
export type LogSink = (line: string) => void;

const ALLOWED = new Set(['kind', 'code', 'reason', 'status', 'received', 'closed', 'port']);

export function makeLogger(sink: LogSink = (l) => process.stdout.write(`${l}\n`)) {
  return (event: string, fields: LogFields = {}) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (ALLOWED.has(k)) safe[k] = v;
    sink(JSON.stringify({ event, ...safe }));
  };
}
export type Logger = ReturnType<typeof makeLogger>;
