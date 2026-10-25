/**
 * Tracker 原始 query 解析。
 *
 * 不能用 Fastify 解析后的 request.query：info_hash / peer_id 是 20 字节
 * 二进制，先做 UTF-8 解码会丢字节。这里从 request.raw.url 自己拆，
 * 把值 percent-decode 成 Buffer。
 */

export type RawQuery = Map<string, Buffer[]>;

export function decodePercentToBuffer(input: string): Buffer {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) break;

    if (char === "%" && index + 2 < input.length) {
      const hex = input.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }

    if (char === "+") {
      bytes.push(0x20);
      continue;
    }

    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      const encoded = Buffer.from(String.fromCodePoint(code), "utf8");
      for (const byte of encoded) bytes.push(byte);
      if (code > 0xffff) index += 1;
    } else {
      bytes.push(code);
    }
  }

  return Buffer.from(bytes);
}

export function bufferToAscii(value: Buffer | undefined): string {
  return value ? value.toString("ascii") : "";
}

export function parseRawQuery(rawUrl: string | undefined): RawQuery {
  const output: RawQuery = new Map();
  if (!rawUrl) return output;

  const questionIndex = rawUrl.indexOf("?");
  if (questionIndex < 0) return output;

  for (const pair of rawUrl.slice(questionIndex + 1).split("&")) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    const key = equals >= 0 ? pair.slice(0, equals) : pair;
    const value = equals >= 0 ? pair.slice(equals + 1) : "";
    const list = output.get(key) ?? [];
    list.push(decodePercentToBuffer(value));
    output.set(key, list);
  }

  return output;
}
