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

// scrypt cost params. N=2^15,r=8 needs ~32MB, which is exactly Node's default
// maxmem ceiling and throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS — so raise maxmem.
const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface WrappedBlob {
  salt: string;
  iv: string;
  tag: string;
  wrapped: string;
}

interface PwBlob {
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

interface CredRecord {
  email?: string;
  pw?: PwBlob; // password encrypted under a PIN-derived key
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
    const vaultKey = this.tryUnwrap(pin);
    if (!vaultKey) return false;
    this.vaultKey = vaultKey;
    return true;
  }

  /** Verify a PIN without changing lock state (used for re-prompts). */
  verifyPin(pin: string): boolean {
    const k = this.tryUnwrap(pin);
    if (!k) return false;
    k.fill(0);
    return true;
  }

  /** Unwrap the vault key from the on-disk blob with the PIN, or null. */
  private tryUnwrap(pin: string): Buffer | null {
    try {
      const blob = this.readWrapped();
      const pinKey = crypto.scryptSync(pin, Buffer.from(blob.salt, 'base64'), 32, SCRYPT_PARAMS);
      const decipher = crypto.createDecipheriv('aes-256-gcm', pinKey, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const vaultKey = Buffer.concat([decipher.update(Buffer.from(blob.wrapped, 'base64')), decipher.final()]);
      pinKey.fill(0);
      return vaultKey;
    } catch {
      return null; // wrong PIN or corrupt vault
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

  // ---- saved login credentials (for re-login autofill) ------------------
  // Email is stored inside the vaultKey-encrypted secrets blob. The PASSWORD is
  // additionally encrypted under a key derived directly from the PIN (scrypt),
  // so it is undecryptable without re-entering the PIN even while the vault is
  // unlocked — and the plaintext is wiped from memory immediately after use.
  // (Changing the PIN invalidates saved passwords; the email is kept.)

  /** Which accounts have a saved email / password. Requires unlock. */
  listCredentials(): Record<string, { email: boolean; password: boolean }> {
    const creds = this.readSecrets<{ credentials?: Record<string, CredRecord> }>().credentials ?? {};
    const out: Record<string, { email: boolean; password: boolean }> = {};
    for (const [id, rec] of Object.entries(creds)) out[id] = { email: !!rec.email, password: !!rec.pw };
    return out;
  }

  getEmail(accountId: string): string | null {
    const creds = this.readSecrets<{ credentials?: Record<string, CredRecord> }>().credentials ?? {};
    return creds[accountId]?.email ?? null;
  }

  /** Save an account's login. `pin` must be the current PIN (gates the password
   *  encryption). `password` is a Buffer the caller should wipe afterwards. */
  setCredential(pin: string, accountId: string, email: string, password: Buffer | null): boolean {
    if (!this.vaultKey) throw new Error('locked');
    if (!this.verifyPin(pin)) return false;
    const secrets = this.readSecrets<{ credentials?: Record<string, CredRecord> }>();
    const creds = secrets.credentials ?? (secrets.credentials = {});
    const rec: CredRecord = creds[accountId] ?? {};
    if (email) rec.email = email;
    if (password && password.length) {
      const salt = crypto.randomBytes(16);
      const key = crypto.scryptSync(pin, salt, 32, SCRYPT_PARAMS);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(password), cipher.final()]);
      key.fill(0);
      rec.pw = { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    }
    creds[accountId] = rec;
    this.writeSecrets(secrets);
    return true;
  }

  /** Decrypt a saved password with the PIN. Returns a Buffer the CALLER MUST
   *  wipe (`.fill(0)`) immediately after use, or null on wrong PIN / none. */
  decryptPassword(pin: string, accountId: string): Buffer | null {
    if (!this.vaultKey) throw new Error('locked');
    const blob = this.readSecrets<{ credentials?: Record<string, CredRecord> }>().credentials?.[accountId]?.pw;
    if (!blob) return null;
    try {
      const key = crypto.scryptSync(pin, Buffer.from(blob.salt, 'base64'), 32, SCRYPT_PARAMS);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
      key.fill(0);
      return pt;
    } catch {
      return null; // wrong PIN
    }
  }

  deleteCredential(accountId: string): void {
    if (!this.vaultKey) return;
    const secrets = this.readSecrets<{ credentials?: Record<string, CredRecord> }>();
    if (secrets.credentials) { delete secrets.credentials[accountId]; this.writeSecrets(secrets); }
  }

  private writeWrapped(vaultKey: Buffer, pin: string): void {
    const salt = crypto.randomBytes(16);
    const pinKey = crypto.scryptSync(pin, salt, 32, SCRYPT_PARAMS);
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
