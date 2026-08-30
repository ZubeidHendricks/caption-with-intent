/**
 * Where the media lives.
 *
 * An interface with a local-disk implementation, so every rule in this package
 * is testable without an S3 account and cannot quietly come to depend on one.
 * The hosted service will use S3, R2 or Spaces behind the same three methods.
 *
 * The one rule that matters regardless of backend: **a key is never a path the
 * caller controls**. Keys are built from an account id and a job id, both of
 * which this service issues. A caller-supplied filename is used for the
 * download name and never for the location, because "../../etc/something" is a
 * perfectly good filename.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ObjectStore {
  put(key: string, body: Readable): Promise<void>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** Bytes held, for a storage quota or a bill. */
  size(key: string): Promise<number>;
}

/** Keys this service issues. Nothing here comes from a caller. */
export const keys = {
  input: (accountId: string, jobId: string, ext: string) =>
    `accounts/${safe(accountId)}/jobs/${safe(jobId)}/input${safeExt(ext)}`,
  output: (accountId: string, jobId: string, ext: string) =>
    `accounts/${safe(accountId)}/jobs/${safe(jobId)}/output${safeExt(ext)}`,
  manifest: (accountId: string, jobId: string) =>
    `accounts/${safe(accountId)}/jobs/${safe(jobId)}/captions.cwi.json`,
};

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
const safeExt = (e: string) => {
  const clean = e.replace(/[^A-Za-z0-9.]/g, '');
  return clean.startsWith('.') ? clean.slice(0, 8) : '';
};

export class DiskStore implements ObjectStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  /**
   * Resolve a key under the root, refusing anything that escapes it.
   *
   * Belt and braces given `keys` above already sanitises, but this is the last
   * line before the filesystem and the cost of being wrong is arbitrary write.
   */
  private path(key: string): string {
    const full = resolve(this.root, key);
    const base = resolve(this.root);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error('that key escapes the store');
    }
    return full;
  }

  async put(key: string, body: Readable): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    // Write to a temporary name and rename into place, so a crash mid-upload
    // cannot leave a truncated file that looks complete to everything after it.
    const tmp = `${p}.partial`;
    await pipeline(body, createWriteStream(tmp));
    await fsp.rename(tmp, p);
  }

  async get(key: string): Promise<Readable> {
    const p = this.path(key);
    if (!existsSync(p)) throw new Error(`no such object: ${key}`);
    return createReadStream(p);
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await fsp.rm(this.path(key), { force: true });
  }

  async size(key: string): Promise<number> {
    const s = await fsp.stat(this.path(key));
    return s.size;
  }
}
