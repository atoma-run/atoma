import type { HostingHandle, HostingIdentity, HostingLaunch, HostingLauncher } from '../contracts/projectHosting.js';
import { SocketLauncher } from './client.js';

/** Durable operations do not lease resources to a connection. A subsequent
 * operation reconnects after a launcher restart, but never replays an unknown write. */
export class HostingClient implements HostingLauncher {
  constructor(private readonly socketPath: string) {}
  private async use<T>(operation: (client: SocketLauncher) => Promise<T>): Promise<T> {
    const client = await SocketLauncher.connect(this.socketPath);
    try { return await operation(client); } finally { client.close(); }
  }
  prepareHosting(identity: HostingIdentity): Promise<string> { return this.use(c => c.prepareHosting(identity)); }
  startHosting(spec: HostingLaunch): Promise<HostingHandle> { return this.use(c => c.startHosting(spec)); }
  inspectHosting(identity: HostingIdentity): Promise<HostingHandle | null> { return this.use(c => c.inspectHosting(identity)); }
  stopHosting(identity: HostingIdentity): Promise<void> { return this.use(c => c.stopHosting(identity)); }
}
