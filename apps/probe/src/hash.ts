// Hash curto para o relatório: permite saber se duas execuções foram na mesma instância da Activity
// sem guardar o identificador original. SHA-256, primeiros 12 caracteres hexadecimais.
export async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

export function clip(value: string | null | undefined, max = 512): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}
