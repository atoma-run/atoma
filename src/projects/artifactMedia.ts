/** MIME is presentation metadata; files still pass the manifest jail and hash check. */
export function artifactMime(bytes: Buffer, path: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (/\.svg$/i.test(path)) return 'image/svg+xml';
  if (/\.pdf$/i.test(path)) return 'application/pdf';
  return isUtf8(bytes) && !bytes.includes(0) ? 'text/plain' : 'application/octet-stream';
}
import { isUtf8 } from 'node:buffer';
