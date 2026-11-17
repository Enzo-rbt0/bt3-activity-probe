import validateV1 from '../../../../packages/report-schema/generated/validate-report-v1.mjs';
import validateV2 from '../../../../packages/report-schema/generated/validate-report-v2.mjs';
import validateV3 from '../../../../packages/report-schema/generated/validate-report-v3.mjs';
import validateV4 from '../../../../packages/report-schema/generated/validate-report-v4.mjs';
import validateV5 from '../../../../packages/report-schema/generated/validate-report-v5.mjs';

export interface ValidationResult { ok: boolean; errors: string[] }

const BY_SCHEMA = {
  'bt3probe.report/1': validateV1, 'bt3probe.report/2': validateV2, 'bt3probe.report/3': validateV3,
  'bt3probe.report/4': validateV4, 'bt3probe.report/5': validateV5,
} as const;

// Usa os validadores pré-compilados (sem eval), seguros sob a Content Security Policy do Discord.
// Escolhe a versão pelo campo "schema": relatórios antigos (formatos 1 a 4) continuam verificáveis.
export function validateReport(data: unknown): ValidationResult {
  const schema = (data as { schema?: unknown } | null)?.schema;
  const v = typeof schema === 'string' ? BY_SCHEMA[schema as keyof typeof BY_SCHEMA] : undefined;
  if (!v) return { ok: false, errors: [`/schema formato desconhecido: ${String(schema)}`] };
  const ok = v(data);
  const errors = ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`);
  return { ok, errors };
}
