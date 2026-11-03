/**
 * This computer's remote identity: one ECDH key pair and the browsers paired
 * with it, shared by every project on the computer so one pairing reaches all
 * of them. Kept beside the per-project data, in <ue-mcp user dir>/remote/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { exportPrivateJwk, exportPublic, generateKeyPair, importPrivateJwk, keyId, sharedSecret } from "@ue-mcp-studio/remote";

export interface PairedPhone {
  id: string;
  publicKey: string;
  label: string;
  addedAt: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class ComputerKeys {
  private key: { privateKey: CryptoKey; publicKey: string } | null = null;
  private phonesCache: { mtime: number; phones: PairedPhone[] } | null = null;
  private readonly secrets = new Map<string, Promise<CryptoKey>>();

  constructor(private readonly dir: string) {}

  private get keyFile(): string {
    return path.join(this.dir, "computer-key.json");
  }

  private get phonesFile(): string {
    return path.join(this.dir, "phones.json");
  }

  async identity(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
    if (this.key) return this.key;
    const saved = readJson<{ publicKey?: string; privateJwk?: JsonWebKey }>(this.keyFile);
    if (saved?.publicKey && saved.privateJwk) {
      this.key = { privateKey: await importPrivateJwk(saved.privateJwk), publicKey: saved.publicKey };
      return this.key;
    }
    const pair = await generateKeyPair(true);
    const publicKey = await exportPublic(pair.publicKey);
    writePrivate(this.keyFile, { publicKey, privateJwk: await exportPrivateJwk(pair.privateKey) });
    // Another project's daemon may have written first; whichever file landed is the identity.
    const landed = readJson<{ publicKey: string; privateJwk: JsonWebKey }>(this.keyFile)!;
    this.key = { privateKey: await importPrivateJwk(landed.privateJwk), publicKey: landed.publicKey };
    return this.key;
  }

  /** Read fresh when the file changed, so a pairing made in one project's daemon reaches the others. */
  phones(): PairedPhone[] {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.phonesFile).mtimeMs;
    } catch {
      return [];
    }
    if (this.phonesCache?.mtime !== mtime) {
      this.phonesCache = { mtime, phones: readJson<PairedPhone[]>(this.phonesFile) ?? [] };
      this.secrets.clear();
    }
    return this.phonesCache.phones;
  }

  async addPhone(publicKey: string, label: string): Promise<PairedPhone> {
    const id = await keyId(publicKey);
    const phones = this.phones().filter((p) => p.id !== id);
    const phone: PairedPhone = { id, publicKey, label: label.slice(0, 120) || "Browser", addedAt: new Date().toISOString() };
    writePrivate(this.phonesFile, [...phones, phone]);
    return phone;
  }

  removePhone(id: string): boolean {
    const phones = this.phones();
    const left = phones.filter((p) => p.id !== id);
    if (left.length === phones.length) return false;
    writePrivate(this.phonesFile, left);
    return true;
  }

  /** The shared secret with a paired phone, or null when that phone is not paired. */
  async secretFor(phoneId: string): Promise<CryptoKey | null> {
    const phone = this.phones().find((p) => p.id === phoneId);
    if (!phone) return null;
    let s = this.secrets.get(phoneId);
    if (!s) {
      s = this.identity().then((me) => sharedSecret(me.privateKey, phone.publicKey));
      this.secrets.set(phoneId, s);
    }
    return s;
  }
}
