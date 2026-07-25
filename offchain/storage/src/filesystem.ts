/**
 * Local filesystem storage backend — owner: person 3.
 *
 * Objects live at <root>/<first 2 hex chars>/<hash>, with a sidecar
 * <hash>.meta.json holding the content type. The two-character fan-out is the
 * same trick git uses: it keeps any single directory small enough that a
 * demo run with thousands of sensor series does not slow down the filesystem.
 *
 * Bytes are written to a temporary file and renamed into place, because rename
 * is atomic on POSIX. Without it a crash mid-write would leave a truncated
 * object under a valid-looking hash, which the verifying `get()` would then
 * (correctly, but confusingly) report as tampering.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { Backend } from './backend';

export const DEFAULT_ROOT = '.offchain-store';

/** Root directory for stored objects. Env-driven so the marker can point it anywhere. */
export const storageRoot = (): string => {
  const configured = process.env.OFFCHAIN_STORAGE_ROOT;
  return configured === undefined || configured === '' ? DEFAULT_ROOT : configured;
};

interface Metadata {
  readonly contentType: string;
  readonly bytes: number;
  readonly storedAt: string;
}

export class FilesystemBackend implements Backend {
  public readonly kind = 'file';

  public constructor(private readonly root: string = storageRoot()) {}

  /** Absolute-ish path of the object body for `hash`. */
  public objectPath(hash: string): string {
    return path.join(this.root, hash.slice(0, 2), hash);
  }

  private metaPath(hash: string): string {
    return `${this.objectPath(hash)}.meta.json`;
  }

  public async write(hash: string, payload: Buffer, contentType: string): Promise<string> {
    const target = this.objectPath(hash);
    await fs.mkdir(path.dirname(target), { recursive: true });

    // Unique temp name: two callers storing the same content concurrently must
    // not write over each other's partial file.
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const meta: Metadata = {
      contentType,
      bytes: payload.length,
      storedAt: new Date().toISOString(),
    };
    try {
      await fs.writeFile(temp, payload);
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    await fs.writeFile(this.metaPath(hash), JSON.stringify(meta, null, 2));
    return `${this.kind}://${target}`;
  }

  public async read(hash: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(this.objectPath(hash));
    } catch {
      // Any read failure — missing, unreadable, a directory — is "not here" as
      // far as a content-addressed store is concerned.
      return undefined;
    }
  }

  public async readContentType(hash: string): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.metaPath(hash), 'utf8');
      const parsed = JSON.parse(raw) as Partial<Metadata>;
      return typeof parsed.contentType === 'string' ? parsed.contentType : undefined;
    } catch {
      return undefined;
    }
  }
}
