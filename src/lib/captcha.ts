import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CAPTCHA_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CAPTCHA_LENGTH = 5;
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

function randomCode(): string {
  const bytes = randomBytes(CAPTCHA_LENGTH);
  return [...bytes].map((byte) => CAPTCHA_ALPHABET[byte % CAPTCHA_ALPHABET.length]).join("");
}

function renderSvg(code: string): string {
  const width = 150;
  const height = 44;
  const chars = [...code].map((char, index) => {
    const x = 18 + index * 25;
    const y = 29 + (index % 2 === 0 ? -2 : 2);
    const rotate = -12 + Math.floor(Math.random() * 25);
    const color = ["#3f6f8f", "#6b4c8a", "#4f7c55", "#8a5a3a"][index % 4];
    return `<text x="${x}" y="${y}" fill="${color}" font-family="monospace" font-size="24" font-weight="700" transform="rotate(${rotate} ${x} ${y})">${escapeXml(char)}</text>`;
  });

  const noise = Array.from({ length: 5 }, (_, index) => {
    const y1 = 5 + Math.random() * (height - 10);
    const y2 = 5 + Math.random() * (height - 10);
    return `<path d="M0 ${y1.toFixed(1)} Q ${(width / 2).toFixed(1)} ${(index % 2 === 0 ? 5 : height - 5).toFixed(1)} ${width} ${y2.toFixed(1)}" stroke="#9aa8b2" stroke-width="1" fill="none" opacity="0.55"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="captcha"><rect width="100%" height="100%" fill="#eef2f4"/>${noise}${chars.join("")}</svg>`;
}

export type CaptchaChallenge = {
  token: string;
  svg: string;
};

export function createCaptcha(secret: string): CaptchaChallenge {
  const answer = randomCode();
  const payload = Buffer.from(
    JSON.stringify({
      a: answer,
      e: Date.now() + CAPTCHA_TTL_MS,
      n: randomBytes(8).toString("hex"),
    }),
  ).toString("base64url");
  return {
    token: `${payload}.${sign(secret, payload)}`,
    svg: renderSvg(answer),
  };
}

export function verifyCaptcha(secret: string, token: string | undefined, input: string): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = sign(secret, payload);
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      a?: unknown;
      e?: unknown;
    };
    if (typeof parsed.a !== "string" || typeof parsed.e !== "number") return false;
    if (parsed.e <= Date.now()) return false;
    return parsed.a === input.trim().toUpperCase();
  } catch {
    return false;
  }
}
