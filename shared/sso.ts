// CUSA applications register one redirect URI for staff login and LINE member linking.
export const CUSA_CALLBACK_PATH = '/api/auth/callback';

export function cusaClaimScopes(value: string | undefined, sameProvider: boolean) {
  const scopes = [...new Set((value ?? 'identity:read profile email').trim().split(/\s+/))];
  if (
    !scopes.includes('identity:read') ||
    scopes.some((s) => !['identity:read', 'profile', 'email', 'line'].includes(s))
  )
    throw new Error(
      'CUSA_CLAIM_SCOPES ต้องมี identity:read และเลือกเพิ่มได้เฉพาะ profile email line',
    );
  if (sameProvider && !scopes.includes('line')) scopes.push('line');
  return scopes.join(' ');
}
