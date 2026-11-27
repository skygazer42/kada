import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export type ProtectedCredentialFile = {
  schema: 2;
  protection: 'windows-dpapi';
  wrappedKey: string;
  nonce: string;
  tag: string;
  ciphertext: string;
};

const associatedData = Buffer.from('kada/application-credentials/v2');

function base64(input: unknown) {
  if (typeof input !== 'string' || !input) throw new Error('Invalid protected credential encoding.');
  const value = Buffer.from(input, 'base64');
  if (value.toString('base64') !== input) throw new Error('Invalid protected credential encoding.');
  return value;
}

function currentUserProtection(input: Buffer, operation: 'Protect' | 'Unprotect'): Promise<Buffer> {
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || !windows) throw new Error('Windows user credentials are unavailable.');
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;" +
    ' $bytes=[Convert]::FromBase64String([Console]::ReadLine());' +
    ' $result=[Security.Cryptography.ProtectedData]::' + operation + '($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    ' [Console]::Write([Convert]::ToBase64String($result));';
  const executable = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      cwd: windows, env: { SystemRoot: windows }, windowsHide: true, timeout: 20_000, maxBuffer: 4096,
    }, (error, output) => {
      if (error) { reject(new Error('Windows could not access the current user protection key.')); return; }
      try { resolve(base64(output.trim())); }
      catch (invalid) { reject(invalid); }
    });
    child.stdin?.on('error', () => reject(new Error('Windows could not read the protection key input.')));
    child.stdin?.end(input.toString('base64') + '\n');
  });
}

export class WindowsCredentialProtection {
  private key?: { wrapped: string; data: Buffer };

  async open(file: ProtectedCredentialFile): Promise<string> {
    if (file.protection !== 'windows-dpapi') throw new Error('Unsupported credential protection.');
    const wrapped = base64(file.wrappedKey);
    const nonce = base64(file.nonce), tag = base64(file.tag), ciphertext = base64(file.ciphertext);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid protected credential data.');
    const data = this.key?.wrapped === file.wrappedKey ? this.key.data : await currentUserProtection(wrapped, 'Unprotect');
    if (data.length !== 32) throw new Error('Invalid protected credential key.');
    const decipher = createDecipheriv('aes-256-gcm', data, nonce).setAAD(associatedData).setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    this.key = { wrapped: file.wrappedKey, data };
    return plaintext;
  }

  async seal(plaintext: string): Promise<ProtectedCredentialFile> {
    if (!this.key) {
      const data = randomBytes(32);
      const wrapped = (await currentUserProtection(data, 'Protect')).toString('base64');
      this.key = { data, wrapped };
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key.data, nonce).setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { schema: 2, protection: 'windows-dpapi', wrappedKey: this.key.wrapped, nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
}
