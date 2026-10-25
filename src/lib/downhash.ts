import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * downhash = `${uid}|${JWT}`；JWT 为手写 HS256，key = sha256(SESSION_SECRET + passkey)。
 * RSS enclosure 使用它，避免在 XML 里暴露裸 passkey。
 */
const TTL_MS = 30 * 60 * 1000;

type Payload = { uid: number; tid: number; exp: number };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function deriveKey(sessionSecret: string, passkey: string): Buffer {
  return createHash("sha256").update(`${sessionSecret}${passkey}`).digest();
}

export function signDownHash(
  sessionSecret: string,
  passkey: string,
  uid: number,
  tid: number,
  ttlMs = TTL_MS,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ uid, tid, exp: Math.floor((Date.now() + ttlMs) / 1000) } satisfies Payload),
  );
  const signature = base64url(
    createHmac("sha256", deriveKey(sessionSecret, passkey)).update(`${header}.${payload}`).digest(),
  );

  return `${String(uid)}|${header}.${payload}.${signature}`;
}

/** 只做签名与 payload 校验；调用方负责按 uid 查用户、按 tid 查种子。 */
export function verifyDownHash(
  sessionSecret: string,
  passkey: string,
  token: string,
  expected: { uid: number; tid: number },
): boolean {
  const separator = token.indexOf("|");
  if (separator <= 0) return false;

  const uid = Number(token.slice(0, separator));
  const jwt = token.slice(separator + 1);
  if (!Number.isInteger(uid) || uid !== expected.uid) return false;

  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];

  const expectedSignature = createHmac("sha256", deriveKey(sessionSecret, passkey))
    .update(`${header}.${payload}`)
    .digest();
  const actualSignature = Buffer.from(signature, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Payload>;
    if (decoded.uid !== expected.uid || decoded.tid !== expected.tid) return false;
    if (typeof decoded.exp !== "number" || decoded.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function parseDownHashUid(token: string): number | null {
  const separator = token.indexOf("|");
  if (separator <= 0) return null;
  const uid = Number(token.slice(0, separator));
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}
