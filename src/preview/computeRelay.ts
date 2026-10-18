import { connect } from 'node:net';

/** Runs only via launcher-issued docker exec INSIDE the preview isolate.
 * Neither the host nor the caller can select an address or port. */
const socket = connect({ host: '127.0.0.1', port: 8080 });
const stop = () => { socket.destroy(); process.stdin.destroy(); };
socket.on('error', () => { process.exitCode = 1; stop(); });
process.stdout.on('error', stop);
process.stdin.on('error', stop);
process.stdin.once('close', stop);
socket.once('close', () => process.stdin.destroy());
process.stdin.pipe(socket); socket.pipe(process.stdout);
