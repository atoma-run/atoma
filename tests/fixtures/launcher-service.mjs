// Real process/socket boundary, fake engine: this fixture never calls Docker.
import { DockerLauncher } from '../../src/launcher/docker.ts';
import { serveLauncher } from '../../src/launcher/service.ts';

class RecordingLauncher extends DockerLauncher {
  armHardExitCleanup() {}
  disarmHardExitCleanup() {}
}
const launcher = new RecordingLauncher({
  image: 'worker-image', workspaceRoot: process.env.ATOMA_TEST_WORKSPACES,
  runDocker: async (args) => {
    process.send?.({ kind: 'engine', args });
    return args[0] === 'network' && args[1] === 'inspect' && args.includes('--format') ? 'attached-worker' : '';
  },
  waitUntilReady: async () => undefined,
});
const hosted = new Map(); const created = new Set();
// One organisation and project for every fixture deployment, as the test uses.
const listed = { orgId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222' };
const service = await serveLauncher({
  hosting: {
    prepareHosting: async id => `/retained/${id.deploymentId}`,
    createHosting: async spec => { created.add(spec.deploymentId); },
    startHosting: async spec => {
      const handle = { hostPort: created.delete(spec.deploymentId) ? 12346 : 12345, image: 'runtime-image' };
      hosted.set(spec.deploymentId, handle); return handle;
    },
    inspectHosting: async id => hosted.get(id.deploymentId) ?? null,
    listHosting: async () => [...hosted.keys(), ...created].map(deploymentId => ({ ...listed, deploymentId })),
    stopHosting: async id => { hosted.delete(id.deploymentId); created.delete(id.deploymentId); },
  },
  socketPath: process.env.ATOMA_TEST_SOCKET,
  launcher,
  disconnectOwner: (family, ownerId) => launcher.reapDisconnectedOwner(family, ownerId),
  hello: { version: 2, image: 'worker-image', previewImage: 'preview-image', previewRuntime: 'runsc', previewOwnership: { uid: 10001, gid: 10001 } },
});
process.send?.({ kind: 'ready' });
process.on('message', () => { void service.close().then(() => process.exit(0)); });
