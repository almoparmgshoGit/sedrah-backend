import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const generate16CharId = (): string => {
  let result = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    result += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return result;
};

export const generateRandomToken = (prefix: string) => {
  return generate16CharId();
};

export const formatUserId = (id: any, pubId?: string) => pubId || id || generate16CharId();
export const formatCompanyId = (id: any, pubId?: string) => pubId || id || generate16CharId();
export const formatPackageId = (id: any, pubId?: string) => pubId || id || generate16CharId();
export const formatChatId = (id: any, pubId?: string) => pubId || id || generate16CharId();
export const formatDocumentId = (id: any, pubId?: string) => pubId || id || generate16CharId();
export const formatBookingId = (id: any, ref?: string) => ref || id || generate16CharId();

export const parseIdOrToken = (param: any) => {
  if (!param) return { isToken: false, value: '' };
  const str = String(param);
  return { isToken: true, value: str };
};

export const parseId = (param: any) => {
  const parsed = parseIdOrToken(param);
  return parsed.value;
};
