import { createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuv'; // base32hex, lowercase

/**
 * Deterministic Google-valid event id for a key (e.g. a task/session identity): sha256 encoded as
 * lowercase base32hex (52 characters, a-v and 0-9). The same key always gives the same id.
 */
export function eventIdFor(key: string): string {
  const bytes = createHash('sha256').update(key, 'utf8').digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
