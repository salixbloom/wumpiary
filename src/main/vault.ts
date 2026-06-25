import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Layered key model (see PLAN.md §8):
//   vaultKey      = random 32 bytes (encrypts the secret blob)
//   pinKey        = scrypt(pin, salt)             — PIN gates access
//   wrapped       = AES-256-GCM(vaultKey, pinKey) — wrong PIN => GCM auth fails
//   on disk       = safeStorage.encrypt({salt,iv,tag,wrapped})  (OS keychain)
//
// scrypt is used instead of a native argon2 module to avoid a native build
// dependency; it is a strong, built-in slow KDF. safeStorage binds the at-rest
// blob to the OS user where a keyring is available; if not, we degrade to a
// plaintext-wrapped file (still PIN-protected by GCM) and report it.

const VAULT_FILE = () => path.join(app.getPath('userData'), 'vault.bin');
const SECRET_FILE = () => path.join(app.getPath('userData'), 'secrets.bin');

interface WrappedBlob {
  salt: string;
  iv: string;
  tag: string;
  wrapped: string;
}

export class Vault {
  private vaultKey: Buffer | null = null;

  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  get hasVault(): boolean {
    return fs.existsSync(VAULT_FILE());
  }

  get unlocked(): boolean {
    return this.vaultKey !== null;
  }

  /** First-run: create a vault protected by the given PIN. */
  setup(pin: string): void {
    if (this.hasVault) throw new Error('vault already exists');
    const vaultKey = crypto.randomBytes(32);
    this.writeWrapped(vaultKey, pin);
    this.vaultKey = vaultKey;
  }

  /** Unlock with PIN. Returns false on wrong PIN. */
  unlock(pin: string): boolean {
    try {
      const blob = this.readWrapped();
      const pinKey = crypto.scryptSync(pin, Buffer.from(blob.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1 });
      const decipher = crypto.createDecipheriv('aes-256-gcm', pinKey, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const vaultKey = Buffer.concat([decipher.update(Buffer.from(blob.wrapped, 'base64')), decipher.final()]);
      this.vaultKey = vaultKey;
      return true;
    } catch {
      return false; // wrong PIN or corrupt vault
    }
  }

  lock(): void {
    this.vaultKey = null;
  }

  /** Change the PIN (must be unlocked). */
  changePin(newPin: string): void {
    if (!this.vaultKey) throw new Error('locked');
    this.writeWrapped(this.vaultKey, newPin);
  }

  /** Read the decrypted secret blob (arbitrary JSON). Requires unlock. */
  readSecrets<T = Record<string, unknown>>(): T {
    if (!this.vaultKey) throw new Error('locked');
    try {
      const raw = fs.readFileSync(SECRET_FILE());
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.vaultKey, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      return JSON.parse(json) as T;
    } catch {
      return {} as T;
    }
  }

  writeSecrets(obj: unknown): void {
    if (!this.vaultKey) throw new Error('locked');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    fs.writeFileSync(SECRET_FILE(), Buffer.concat([iv, cipher.getAuthTag(), enc]));
  }

  private writeWrapped(vaultKey: Buffer, pin: string): void {
    const salt = crypto.randomBytes(16);
    const pinKey = crypto.scryptSync(pin, salt, 32, { N: 1 << 15, r: 8, p: 1 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', pinKey, iv);
    const wrapped = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
    const blob: WrappedBlob = {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      wrapped: wrapped.toString('base64'),
    };
    const json = JSON.stringify(blob);
    const out = this.encryptionAvailable ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
    fs.writeFileSync(VAULT_FILE(), out);
  }

  private readWrapped(): WrappedBlob {
    const raw = fs.readFileSync(VAULT_FILE());
    const json = this.encryptionAvailable ? safeStorage.decryptString(raw) : raw.toString('utf8');
    return JSON.parse(json) as WrappedBlob;
  }
}
