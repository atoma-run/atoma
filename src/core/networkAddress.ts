import { BlockList, isIP } from 'node:net';

const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
/** Global unicast only (2000::/3), minus the documentation, 6to4, Teredo and IETF blocks. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** True only for an address a public service would answer from. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  return GLOBAL_V6.check(address, 'ipv6') && !BLOCKED_V6.check(address, 'ipv6');
}
