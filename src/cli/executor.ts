#!/usr/bin/env node
import { callExecutor } from '../projects/executorTransport.js';
import { EXECUTOR_COMPATIBILITY } from '../contracts/executorVersion.js';

const [command, socket] = process.argv.slice(2);
if (command === '--help') {
  console.log('Usage: executor --compatibility | --health /absolute/generation.sock | --idle /absolute/generation.sock | --retire-previews /absolute/generation.sock');
} else if (command === '--compatibility') {
  console.log(EXECUTOR_COMPATIBILITY);
} else if (command === '--retire-previews' && socket?.startsWith('/')) {
  try { console.log(JSON.stringify(await callExecutor(socket, { method: 'retire-previews' }))); }
  catch { process.exitCode = 1; }
} else if ((command === '--health' || command === '--idle') && socket?.startsWith('/')) {
  try {
    const health = await callExecutor<{ compatibility: number; release: string; idle: boolean; ready: boolean }>(socket, { method: 'health' });
    if (health.compatibility !== EXECUTOR_COMPATIBILITY) throw new Error('Executor protocol mismatch');
    if (!health.ready) throw new Error('Executor is still initializing');
    console.log(JSON.stringify(health));
    if (command === '--idle' && !health.idle) process.exitCode = 75;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Executor unavailable'); process.exitCode = 1; }
} else { console.error('Use executor --help'); process.exitCode = 2; }
