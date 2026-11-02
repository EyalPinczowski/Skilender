import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of Google Calendar refresh tokens at rest (v0.3b).
 * AES-256-GCM, random 12-byte IV per message. The associated data binds each ciphertext to one
 * user and one key id, so a value copied to another user's row (or relabelled with another key id)
 * fails authentication. Output: `keyId.iv.ciphertext.tag`, each part base64url.
 *
 * Nothing here logs, and error messages never include keys, ciphertext or plaintext.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export interface CalendarKey {
  id: string;
  key: Buffer;
}

export class CalendarCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarCryptoError';
  }
}

export type ParsedCalendarKeys =
  { keys: CalendarKey[]; problems: [] } | { keys: []; problems: string[] };

/**
 * Parses `v2:<base64>,v1:<base64>` (newest first). Returns the problems found instead of throwing;
 * problem text names the position and the rule, never the key material.
 */
export function parseCalendarTokenKeys(raw: string): ParsedCalendarKeys {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return { keys: [], problems: ['must list at least one key as <id>:<base64>'] };
  }
  const problems: string[] = [];
  const keys: CalendarKey[] = [];
  entries.forEach((entry, index) => {
    const n = index + 1;
    const sep = entry.indexOf(':');
    const id = sep < 0 ? '' : entry.slice(0, sep);
    const b64 = sep < 0 ? '' : entry.slice(sep + 1);
    if (!KEY_ID_PATTERN.test(id)) {
      problems.push(`key ${n}: id must be 1 to 32 letters, digits, "_" or "-", then ":"`);
      return;
    }
    if (keys.some((k) => k.id === id)) {
      problems.push(`key ${n}: id is used more than once`);
      return;
    }
    if (!BASE64_PATTERN.test(b64)) {
      problems.push(`key ${n}: value is not base64`);
      return;
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== KEY_BYTES) {
      problems.push(`key ${n}: must decode to exactly ${KEY_BYTES} bytes`);
      return;
    }
    keys.push({ id, key });
  });
  return problems.length > 0 ? { keys: [], problems } : { keys, problems: [] };
}

const aad = (userId: string, keyId: string) => Buffer.from(`${userId}\n${keyId}`, 'utf8');
const b64u = (b: Buffer) => b.toString('base64url');

export class CalendarTokenCrypto {
  private readonly keys: readonly CalendarKey[];

  /** `keys` is newest first; the first key encrypts, any listed key decrypts. */
  constructor(keys: readonly CalendarKey[]) {
    if (keys.length === 0) throw new CalendarCryptoError('at least one key is required');
    for (const k of keys) {
      if (k.key.length !== KEY_BYTES) {
        throw new CalendarCryptoError(`key "${k.id}" must be exactly ${KEY_BYTES} bytes`);
      }
      if (!KEY_ID_PATTERN.test(k.id)) throw new CalendarCryptoError('invalid key id');
    }
    this.keys = keys;
  }

  encrypt(plaintext: string, userId: string): string {
    // An empty value would produce a token decrypt() rejects, so refuse it up front.
    if (plaintext.length === 0) throw new CalendarCryptoError('cannot encrypt an empty token');
    const current = this.keys[0]!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', current.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(userId, current.id));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [current.id, b64u(iv), b64u(ct), b64u(cipher.getAuthTag())].join('.');
  }

  decrypt(value: string, userId: string): string {
    const parts = value.split('.');
    const [keyId, ivPart, ctPart, tagPart] = parts;
    const key = this.keys.find((k) => k.id === keyId);
    if (parts.length !== 4 || !key || !ivPart || !ctPart || !tagPart) {
      throw new CalendarCryptoError('cannot decrypt token');
    }
    try {
      const iv = Buffer.from(ivPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('shape');
      const decipher = createDecipheriv('aes-256-gcm', key.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(userId, key.id));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ctPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // One generic message: never reveal which check failed or echo any input.
      throw new CalendarCryptoError('cannot decrypt token');
    }
  }

  /** True when the value was not written with the newest key (or is not readable): re-encrypt it. */
  needsReencrypt(value: string): boolean {
    return value.split('.')[0] !== this.keys[0]!.id;
  }
}
