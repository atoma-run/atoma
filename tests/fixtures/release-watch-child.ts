// A launcher process started from a release path, as atoma-hosting-launcher is:
// it serves the real launcher socket and restarts on the release watch.
import { DockerLauncher } from '../../src/launcher/docker.js';
import { serveLauncher } from '../../src/launcher/service.js';
import { RELEASE_RESTART_EXIT_CODE, watchRelease } from '../../src/launcher/releaseWatch.js';

const [entry, socketPath] = process.argv.slice(2);
const service = await serveLauncher({
  socketPath: socketPath!,
  launcher: new DockerLauncher({ image: 'worker-image', runDocker: async () => '' }),
  hello: { version: 2, image: 'worker-image', previewImage: 'preview-image', previewRuntime: 'runsc', previewOwnership: { uid: 10001, gid: 10001 } },
  disconnectOwner: async () => undefined,
});
watchRelease({ entry: entry!, idle: () => service.idle(), intervalMs: 50,
  restart: () => { void service.close().then(() => process.exit(RELEASE_RESTART_EXIT_CODE)); } });
console.log('ready');
