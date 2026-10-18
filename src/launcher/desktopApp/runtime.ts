import { delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { ComputeDesktopController } from './controller.js';
import { computeDesktopCommandSchema } from '../../contracts/computeDesktop.js';
import { z } from 'zod';
// Finder does not inherit a shell PATH. Docker Desktop's own CLI directories are
// fixed here, never supplied by the renderer. Existing CLI paths stay available.
const dockerPaths = process.platform === 'darwin' ? ['/Applications/Docker.app/Contents/Resources/bin', '/usr/local/bin']
  : ['C:\\Program Files\\Docker\\Docker\\resources\\bin'];
process.env.PATH = [...dockerPaths.filter(path => existsSync(path)), process.env.PATH ?? ''].join(delimiter);
const port = process.parentPort;
if (!port) throw new Error('Compute runtime requires its desktop parent');
const send = (message: unknown) => port.postMessage(message);
const controller = new ComputeDesktopController(process.argv[2] ?? '0.4.0', state => send({ kind: 'state', state }),
  url => send({ kind: 'pairing', url }));
const request = z.object({ id: z.number().int().positive(), command: computeDesktopCommandSchema }).strict();
port.on('message', event => {
  const parsed = request.safeParse(event.data);
  if (!parsed.success) return;
  void controller.execute(parsed.data.command).then(() => send({ kind: 'reply', id: parsed.data.id, ok: true }),
    () => send({ kind: 'reply', id: parsed.data.id, ok: false }));
});
setInterval(() => { void controller.refresh(); }, 3000);
send({ kind: 'state', state: controller.snapshot() });
