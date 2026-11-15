import validateGenerated from '../../../../packages/report-schema/generated/validate-report.mjs';

export interface ValidationResult { ok: boolean; errors: string[] }

// Usa o validador pré-compilado (sem eval), seguro sob a Content Security Policy do Discord.
export function validateReport(data: unknown): ValidationResult {
  const ok = validateGenerated(data);
  const errors = ok
    ? []
    : (validateGenerated.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`);
  return { ok, errors };
}
