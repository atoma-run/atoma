import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Secrets travel through stdin, never argv, environment, logs or plaintext files. */
async function invoke(command: string, args: string[], input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 16384) { failed = true; child.kill(); } });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('System credential storage unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (code || failed) reject(new Error('System credential storage unavailable')); else resolve(output.trim()); });
    child.stdin.end(input);
  });
}

/** macOS Keychain / Windows DPAPI CurrentUser. The latter keeps only ciphertext
 * in the private operational directory, bound to this user's Windows account. */
export class ComputeCredential {
  private readonly account: string;
  private readonly service: string;
  private readonly file: string;
  constructor(root: string, origin: string, deviceId: string, private readonly platform = process.platform) {
    this.account = z.string().uuid().parse(deviceId);
    const identity = createHash('sha256').update(new URL(origin).origin).digest('hex');
    this.service = `run.atoma.compute.${identity}`;
    this.file = join(root, `${identity}-${this.account}.credential`);
    if (platform !== 'darwin' && platform !== 'win32') throw new Error('Atoma Compute supports macOS and Windows');
  }
  async save(value: string): Promise<void> {
    const secret = credential.parse(value);
    if (this.platform === 'darwin') {
      // security's interactive command parser receives only closed alphabets.
      await invoke('/usr/bin/security', ['-i'], `add-generic-password -U -a ${this.account} -s ${this.service} -w ${secret}\n`);
      // Interactive security may exit zero after a command failure. Read back
      // before reporting success; never replace the config on a denied write.
      if (await this.read() !== secret) throw new Error('System credential write was not confirmed');
    } else {
      const ciphertext = await this.dpapi('Protect', secret);
      if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext) || ciphertext.length > 16384) throw new Error('Invalid system credential response');
      if (existsSync(this.file) && (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink())) throw new Error('Invalid credential file');
      writeFileSync(this.file, ciphertext, { mode: 0o600, flush: true });
    }
  }
  async read(): Promise<string> {
    if (this.platform === 'darwin') return credential.parse(await invoke('/usr/bin/security', ['find-generic-password', '-a', this.account, '-s', this.service, '-w']));
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid credential file');
    const ciphertext = readFileSync(this.file, 'utf8');
    if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext)) throw new Error('Invalid credential file');
    return credential.parse(await this.dpapi('Unprotect', ciphertext));
  }
  async remove(): Promise<void> {
    if (this.platform === 'darwin') await invoke('/usr/bin/security', ['delete-generic-password', '-a', this.account, '-s', this.service]);
    else rmSync(this.file, { force: true });
  }
  private dpapi(operation: 'Protect' | 'Unprotect', input: string): Promise<string> {
    const encrypt = operation === 'Protect';
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); ` +
      `$bytes=${encrypt ? '[Text.Encoding]::UTF8.GetBytes($value)' : '[Convert]::FromBase64String($value)'}; ` +
      `$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      `[Console]::Out.Write(${encrypt ? '[Convert]::ToBase64String($result)' : '[Text.Encoding]::UTF8.GetString($result)'});`;
    return invoke('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], input);
  }
}
