import { createHmac, randomBytes } from "node:crypto";

/** RFC 6238 TOTP：SHA-1、6 位、30 秒；允许前后各一个窗口。 */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let output = "";
  let value = 0;
  let bits = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(secret: string): Buffer {
  const normalized = secret.replace(/=+$/g, "").toUpperCase();
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;

  for (const char of normalized) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function totpCode(secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);

  return String(code % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;

  const now = Date.now();
  for (let offset = -window; offset <= window; offset += 1) {
    if (totpCode(secret, now + offset * STEP_SECONDS * 1000) === normalized) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(randomBytes(5).toString("hex").toUpperCase());
  }
  return [...codes];
}
