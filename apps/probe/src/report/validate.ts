import validateV1 from '../../../../packages/report-schema/generated/validate-report-v1.mjs';
import validateV2 from '../../../../packages/report-schema/generated/validate-report-v2.mjs';
import validateV3 from '../../../../packages/report-schema/generated/validate-report-v3.mjs';

export interface ValidationResult { ok: boolean; errors: string[] }

const BY_SCHEMA = { 'bt3probe.report/1': validateV1, 'bt3probe.report/2': validateV2, 'bt3probe.report/3': validateV3 } as const;

// Usa os validadores pré-compilados (sem eval), seguros sob a Content Security Policy do Discord.
// Escolhe a versão pelo campo "schema": relatórios antigos (formatos 1 e 2) continuam verificáveis.
export function validateReport(data: unknown): ValidationResult {
  const schema = (data as { schema?: unknown } | null)?.schema;
  const v = typeof schema === 'string' ? BY_SCHEMA[schema as keyof typeof BY_SCHEMA] : undefined;
  if (!v) return { ok: false, errors: [`/schema formato desconhecido: ${String(schema)}`] };
  const ok = v(data);
  const errors = ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`);
  return { ok, errors };
}
