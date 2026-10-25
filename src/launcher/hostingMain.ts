import { lstatSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { DockerHosting } from './hosting.js';
import { DockerLauncher, hostContainerUser } from './docker.js';
import { serveLauncher } from './service.js';
import { LAUNCHER_PROTOCOL_VERSION } from '../contracts/launcherRpc.js';
import { RELEASE_RESTART_EXIT_CODE, watchRelease } from './releaseWatch.js';

/** Optional hosting-only endpoint for hosts still using the legacy run launcher. */
async function main(): Promise<void> {
  if (process.argv.includes('--help')) { console.log('Hosted applications launcher: ATOMA_HOSTING_SOCKET, ATOMA_HOSTING_ROOT, ATOMA_HOSTING_IMAGE, ATOMA_HOSTING_RELAY_IMAGE. Linux and gVisor required.'); return; }
  if (process.platform !== 'linux') throw new Error('Linux required');
  const socketPath = process.env['ATOMA_HOSTING_SOCKET'] ?? '';
  if (!path.isAbsolute(socketPath)) throw new Error('Absolute hosting socket required');
  const user = hostContainerUser() ?? '10001:10001';
  const image = process.env['ATOMA_HOSTING_IMAGE'] ?? '';
  const relayImage = process.env['ATOMA_HOSTING_RELAY_IMAGE'] ?? '';
  const root = process.env['ATOMA_HOSTING_ROOT'] ?? '';
  const hosting = new DockerHosting({ root, image, relayImage, user, ...(process.env['ATOMA_HOSTING_BROWSER_IMAGE'] ? { browserImage: process.env['ATOMA_HOSTING_BROWSER_IMAGE'] } : {}) });
  // Probe before unlink; a second process must never steal a live endpoint.
  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (e: NodeJS.ErrnoException) => e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? resolve(false) : reject(e));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Endpoint probe timed out')); });
  });
  if (live) throw new Error('Hosting launcher already running');
  try { if (!lstatSync(socketPath).isSocket()) throw new Error('Not a socket'); rmSync(socketPath); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const [uid, gid] = user.split(':').map(Number);
  const service = await serveLauncher({ socketPath, hosting, hostingOnly: true,
    launcher: new DockerLauncher({ image: relayImage, previewImage: image, previewRuntime: 'runsc', previewUser: user }),
    hello: { version: LAUNCHER_PROTOCOL_VERSION, image: relayImage, previewImage: image, previewRuntime: 'runsc', previewOwnership: { uid: uid!, gid: gid! } },
    disconnectOwner: async () => { throw new Error('No ephemeral owners on this endpoint'); },
  });
  // Application containers outlive the socket, launcher process and platform release.
  let closing = false;
  const stop = () => { if (closing) return; closing = true; void service.close().then(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // A deployment moves `current` but never restarts this unit: restart on the
  // new code at the first moment no operation is open (src/launcher/releaseWatch.ts).
  if (process.argv[1]) watchRelease({ entry: process.argv[1], idle: () => service.idle(), restart: (from, to) => {
    if (closing) return;
    closing = true;
    console.log(`Hosting launcher restarting on the active release: ${path.basename(path.dirname(path.dirname(path.dirname(from))))} -> ${path.basename(path.dirname(path.dirname(path.dirname(to))))}`);
    void service.close().then(() => process.exit(RELEASE_RESTART_EXIT_CODE), () => process.exit(RELEASE_RESTART_EXIT_CODE));
  } });
  console.log('Hosting launcher ready');
}
main().catch(() => { console.error('Hosting launcher failed; check private configuration and socket directory'); process.exitCode = 1; });
