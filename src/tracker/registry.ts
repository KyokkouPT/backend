import { isIPv4 } from "node:net";

/**
 * 单进程 Tracker 的内存 peer 注册表。
 * 重启后 peers 丢失是可接受的 v1 行为；持久化的是统计计数。
 */
export type TrackerPeer = {
  peerIdHex: string;
  ip: string;
  port: number;
  userId: number;
  lastSeen: number;
  left: number;
  seeder: boolean;
};

const peers = new Map<string, Map<string, TrackerPeer>>();

export function peerKey(userId: number, peerIdHex: string): string {
  return `${String(userId)}:${peerIdHex}`;
}

export function upsertPeer(infoHashHex: string, peer: TrackerPeer): void {
  let bucket = peers.get(infoHashHex);
  if (!bucket) {
    bucket = new Map();
    peers.set(infoHashHex, bucket);
  }
  bucket.set(peerKey(peer.userId, peer.peerIdHex), peer);
}

export function removePeer(infoHashHex: string, key: string): void {
  const bucket = peers.get(infoHashHex);
  if (!bucket) return;
  bucket.delete(key);
  if (bucket.size === 0) peers.delete(infoHashHex);
}

export function listPeers(infoHashHex: string): TrackerPeer[] {
  return [...(peers.get(infoHashHex)?.values() ?? [])];
}

export function countPeers(infoHashHex: string): { seeders: number; leechers: number } {
  const all = listPeers(infoHashHex);
  const seeders = all.filter((peer) => peer.seeder).length;
  return { seeders, leechers: all.length - seeders };
}

export function prunePeers(ttlMs: number): number {
  const cutoff = Date.now() - ttlMs;
  let removed = 0;

  for (const [infoHash, bucket] of peers) {
    for (const [key, peer] of bucket) {
      if (peer.lastSeen < cutoff) {
        bucket.delete(key);
        removed += 1;
      }
    }
    if (bucket.size === 0) peers.delete(infoHash);
  }

  return removed;
}

/** 把 IPv6 文本解析成 16 字节；支持 :: 缩写。 */
export function parseIPv6(address: string): Buffer | null {
  const zoneIndex = address.indexOf("%");
  const text = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const output: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      output.push((value >> 8) & 0xff, value & 0xff);
    }
    return output;
  };

  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  if (halves.length === 1) {
    return head.length === 16 ? Buffer.from(head) : null;
  }

  const missing = 16 - head.length - tail.length;
  if (missing < 1) return null;

  return Buffer.from([...head, ...Array.from({ length: missing }, () => 0), ...tail]);
}

export function compactIPv4(list: TrackerPeer[]): Buffer {
  const parts: Buffer[] = [];
  for (const peer of list) {
    if (!isIPv4(peer.ip)) continue;
    const octets = peer.ip.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      continue;
    }
    const buffer = Buffer.alloc(6);
    buffer.writeUInt8(octets[0] ?? 0, 0);
    buffer.writeUInt8(octets[1] ?? 0, 1);
    buffer.writeUInt8(octets[2] ?? 0, 2);
    buffer.writeUInt8(octets[3] ?? 0, 3);
    buffer.writeUInt16BE(peer.port, 4);
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

export function compactIPv6(list: TrackerPeer[]): Buffer {
  const parts: Buffer[] = [];
  for (const peer of list) {
    if (isIPv4(peer.ip)) continue;
    const address = parseIPv6(peer.ip);
    if (!address) continue;
    const buffer = Buffer.alloc(18);
    address.copy(buffer, 0);
    buffer.writeUInt16BE(peer.port, 16);
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

/** 去掉 IPv4-mapped IPv6 前缀，让 compact 输出走 IPv4。 */
export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    const candidate = ip.slice("::ffff:".length);
    if (isIPv4(candidate)) return candidate;
  }
  return ip;
}

export function resetRegistryForTests(): void {
  peers.clear();
}
