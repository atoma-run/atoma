import type { createServer } from '/private/tmp/attica-485-exact-review-20261021/browser/control-server.ts';
import type { Server } from 'node:http';
declare const application: ReturnType<typeof createServer>;
export const actualPort = application.address().port;
declare const generic: Server;
export const genericPort = generic.address().port;
