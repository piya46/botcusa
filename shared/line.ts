export const lineRecipientPattern = /^[UCR][0-9a-f]{32}$/;
export function lineRecipientType(id: string) {
  if (!lineRecipientPattern.test(id)) return null;
  return id[0] === 'C' ? 'group' : id[0] === 'R' ? 'room' : 'user';
}
