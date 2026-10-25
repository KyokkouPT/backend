import { createHash } from "node:crypto";

/**
 * Bencode 解析/编码。
 *
 * Tracker 与 .torrent 下载都依赖“info 原始字节”：info_hash 是 info 字典
 * 原始字节的 SHA-1，重新编码后哪怕语义相同、字节不同也会导致 hash 变化。
 * 因此解析时保留每个节点的原始区间，重构时只替换需要改的部分。
 */

export type BencodeNode =
  | { kind: "int"; start: number; end: number; value: number }
  | { kind: "bytes"; start: number; end: number; value: Buffer }
  | { kind: "list"; start: number; end: number; items: BencodeNode[] }
  | {
      kind: "dict";
      start: number;
      end: number;
      entries: { key: string; value: BencodeNode }[];
    };

export class BencodeError extends Error {
  override name = "BencodeError";
}

function fail(message: string): never {
  throw new BencodeError(message);
}

function decodeNode(buffer: Buffer, offset: number): { node: BencodeNode; next: number } {
  if (offset >= buffer.length) fail("unexpected end of bencode data");

  const marker = buffer[offset];

  if (marker === 0x69 /* i */) {
    const end = buffer.indexOf(0x65 /* e */, offset + 1);
    if (end < 0) fail("unterminated integer");
    const text = buffer.subarray(offset + 1, end).toString("ascii");
    if (!/^-?\d+$/.test(text)) fail(`invalid integer: ${text}`);
    return {
      node: { kind: "int", start: offset, end: end + 1, value: Number(text) },
      next: end + 1,
    };
  }

  if (marker === 0x6c /* l */) {
    const items: BencodeNode[] = [];
    let cursor = offset + 1;
    while (buffer[cursor] !== 0x65 /* e */) {
      if (cursor >= buffer.length) fail("unterminated list");
      const decoded = decodeNode(buffer, cursor);
      items.push(decoded.node);
      cursor = decoded.next;
    }
    return { node: { kind: "list", start: offset, end: cursor + 1, items }, next: cursor + 1 };
  }

  if (marker === 0x64 /* d */) {
    const entries: { key: string; value: BencodeNode }[] = [];
    let cursor = offset + 1;
    while (buffer[cursor] !== 0x65 /* e */) {
      if (cursor >= buffer.length) fail("unterminated dictionary");
      const keyNode = decodeNode(buffer, cursor);
      if (keyNode.node.kind !== "bytes") fail("dictionary key must be a byte string");
      const valueNode = decodeNode(buffer, keyNode.next);
      entries.push({ key: keyNode.node.value.toString("utf8"), value: valueNode.node });
      cursor = valueNode.next;
    }
    return { node: { kind: "dict", start: offset, end: cursor + 1, entries }, next: cursor + 1 };
  }

  // byte string: <length>:<bytes>
  const colon = buffer.indexOf(0x3a /* : */, offset);
  if (colon < 0) fail("unterminated byte string length");
  const lengthText = buffer.subarray(offset, colon).toString("ascii");
  if (!/^\d+$/.test(lengthText)) fail(`invalid byte string length: ${lengthText}`);
  const length = Number(lengthText);
  const start = colon + 1;
  const end = start + length;
  if (end > buffer.length) fail("byte string exceeds buffer");
  return { node: { kind: "bytes", start: offset, end, value: buffer.subarray(start, end) }, next: end };
}

/** 解析整个 buffer；要求恰好消费完（尾部空白不允许）。 */
export function decodeTorrent(buffer: Buffer): BencodeNode {
  const decoded = decodeNode(buffer, 0);
  if (decoded.next !== buffer.length) fail("trailing bytes after bencode value");
  return decoded.node;
}

function sortedEntries(entries: { key: string; value: BencodeNode }[]) {
  return [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")));
}

function writeValue(node: BencodeNode): Buffer[] {
  switch (node.kind) {
    case "int":
      return [Buffer.from(`i${String(node.value)}e`, "ascii")];
    case "bytes":
      return [encodeBytes(node.value)];
    case "list":
      return [Buffer.from("l", "ascii"), ...node.items.flatMap(writeValue), Buffer.from("e", "ascii")];
    case "dict": {
      const parts: Buffer[] = [Buffer.from("d", "ascii")];
      for (const entry of sortedEntries(node.entries)) {
        parts.push(encodeBytes(Buffer.from(entry.key, "utf8")), ...writeValue(entry.value));
      }
      parts.push(Buffer.from("e", "ascii"));
      return parts;
    }
  }
}

export function encodeBytes(value: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${String(value.length)}:`, "ascii"), value]);
}

export function encodeString(value: string): Buffer {
  return encodeBytes(Buffer.from(value, "utf8"));
}

export function encodeBencode(value: BencodeValue): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) fail("bencode integers must be integers");
    return Buffer.from(`i${String(value)}e`, "ascii");
  }
  if (typeof value === "string") return encodeString(value);
  if (Buffer.isBuffer(value)) return encodeBytes(value);
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l", "ascii"), ...value.map(encodeBencode), Buffer.from("e", "ascii")]);
  }
  const entries = Object.entries(value)
    .map(([key, child]) => ({ key, value: child }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")));
  return Buffer.concat([
    Buffer.from("d", "ascii"),
    ...entries.flatMap((entry) => [encodeString(entry.key), encodeBencode(entry.value)]),
    Buffer.from("e", "ascii"),
  ]);
}

export type BencodeValue = number | string | Buffer | BencodeValue[] | { [key: string]: BencodeValue };

export type ParsedTorrent = {
  infoHash: string;
  name: string;
  totalSize: number;
  pieceLength: number;
  files: { path: string; size: number }[];
  announce: string | null;
  /** info 字典的原始字节；下载时原样保留。 */
  infoBytes: Buffer;
  raw: Buffer;
};

function dictValue(node: BencodeNode, key: string): BencodeNode | undefined {
  if (node.kind !== "dict") return undefined;
  return node.entries.find((entry) => entry.key === key)?.value;
}

function nodeText(node: BencodeNode | undefined): string | null {
  return node && node.kind === "bytes" ? node.value.toString("utf8") : null;
}

function nodeInt(node: BencodeNode | undefined): number | null {
  return node && node.kind === "int" ? node.value : null;
}

/** 解析 .torrent（不重新编码 info，返回原始字节）。 */
export function parseTorrent(raw: Buffer): ParsedTorrent {
  const root = decodeTorrent(raw);
  if (root.kind !== "dict") fail("torrent root must be a dictionary");

  const info = dictValue(root, "info");
  if (!info || info.kind !== "dict") fail("torrent is missing the info dictionary");

  const name = nodeText(dictValue(info, "name"));
  if (!name) fail("torrent info is missing name");

  const pieceLength = nodeInt(dictValue(info, "piece length")) ?? 0;

  const files: { path: string; size: number }[] = [];
  const singleLength = nodeInt(dictValue(info, "length"));
  if (singleLength !== null) {
    files.push({ path: name, size: singleLength });
  } else {
    const filesNode = dictValue(info, "files");
    if (!filesNode || filesNode.kind !== "list") fail("torrent info has neither length nor files");
    for (const fileNode of filesNode.items) {
      const length = nodeInt(dictValue(fileNode, "length"));
      const pathNode = dictValue(fileNode, "path");
      if (length === null || !pathNode || pathNode.kind !== "list") fail("invalid file entry");
      const parts = pathNode.items
        .map((part) => (part.kind === "bytes" ? part.value.toString("utf8") : ""))
        .filter((part) => part.length > 0);
      files.push({ path: parts.join("/"), size: length });
    }
  }

  const infoBytes = raw.subarray(info.start, info.end);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  return {
    infoHash: createHash("sha1").update(infoBytes).digest("hex"),
    name,
    totalSize,
    pieceLength,
    files,
    announce: nodeText(dictValue(root, "announce")),
    infoBytes: Buffer.from(infoBytes),
    raw,
  };
}

/**
 * 下载时替换 announce：保留 info 原始字节与其它顶层字段的原始片段，
 * 丢弃 announce-list（否则客户端会优先使用旧列表），只写入新 announce。
 */
export function rewriteAnnounce(raw: Buffer, announce: string): Buffer {
  const root = decodeTorrent(raw);
  if (root.kind !== "dict") fail("torrent root must be a dictionary");

  const kept = root.entries
    .filter((entry) => entry.key !== "announce" && entry.key !== "announce-list")
    .map((entry) => ({ key: entry.key, bytes: raw.subarray(entry.value.start, entry.value.end) }));

  const announceBytes = encodeString(announce);
  const items = [...kept, { key: "announce", bytes: announceBytes }].sort((a, b) =>
    Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")),
  );

  const parts: Buffer[] = [Buffer.from("d", "ascii")];
  for (const item of items) {
    parts.push(encodeString(item.key), item.bytes);
  }
  parts.push(Buffer.from("e", "ascii"));

  return Buffer.concat(parts);
}
