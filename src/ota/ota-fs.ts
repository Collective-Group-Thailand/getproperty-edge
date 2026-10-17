import { createHash } from 'node:crypto';
import { constants, promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

/** Filesystem operations the A/B slot logic needs — real, or in memory for unit tests. */
export interface OtaFs {
  readText(path: string): Promise<string | null>;
  writeTextAtomic(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readlink(path: string): Promise<string | null>;
  /** Atomically (re)points `link` at `target` (symlink to a temp name + rename). */
  symlinkAtomic(target: string, link: string): Promise<void>;
  /** Streams chunks into `path` (created 0700→0755 after verification), returns sha256 and size. */
  writeStream(path: string, chunks: AsyncIterable<Buffer>, maxBytes: number): Promise<{ sha256: string; size: number }>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class NodeOtaFs implements OtaFs {
  async readText(p: string): Promise<string | null> {
    try {
      return await fsp.readFile(p, 'utf8');
    } catch {
      return null;
    }
  }
  async writeTextAtomic(p: string, data: string): Promise<void> {
    await fsp.mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, p);
  }
  async remove(p: string): Promise<void> {
    await fsp.rm(p, { force: true });
  }
  async mkdirp(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true });
  }
  async readlink(p: string): Promise<string | null> {
    try {
      return await fsp.readlink(p);
    } catch {
      return null;
    }
  }
  async symlinkAtomic(target: string, link: string): Promise<void> {
    const tmp = join(dirname(link), `.${Date.now()}-${process.pid}.lnk`);
    await fsp.symlink(target, tmp);
    await fsp.rename(tmp, link);
  }
  async writeStream(
    p: string,
    chunks: AsyncIterable<Buffer>,
    maxBytes: number,
  ): Promise<{ sha256: string; size: number }> {
    await fsp.mkdir(dirname(p), { recursive: true });
    const h = createHash('sha256');
    let size = 0;
    const fh = await fsp.open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o700);
    try {
      for await (const c of chunks) {
        size += c.length;
        if (size > maxBytes) throw new Error(`artifact larger than ${maxBytes} bytes`);
        h.update(c);
        await fh.write(c);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { sha256: h.digest('hex'), size };
  }
  async rename(a: string, b: string): Promise<void> {
    await fsp.rename(a, b);
  }
  async chmod(p: string, mode: number): Promise<void> {
    await fsp.chmod(p, mode);
  }
  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }
}

/** In-memory filesystem for the A/B slot unit tests. */
export class MemoryOtaFs implements OtaFs {
  readonly files = new Map<string, Buffer>();
  readonly links = new Map<string, string>();
  readonly modes = new Map<string, number>();
  failNextRename = false;

  async readText(p: string) {
    return this.files.get(p)?.toString('utf8') ?? null;
  }
  async writeTextAtomic(p: string, d: string) {
    this.files.set(p, Buffer.from(d));
  }
  async remove(p: string) {
    this.files.delete(p);
    this.links.delete(p);
  }
  async mkdirp() {}
  async readlink(p: string) {
    return this.links.get(p) ?? null;
  }
  async symlinkAtomic(target: string, link: string) {
    this.links.set(link, target);
  }
  async writeStream(p: string, chunks: AsyncIterable<Buffer>, maxBytes: number) {
    const h = createHash('sha256');
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of chunks) {
      size += c.length;
      if (size > maxBytes) throw new Error(`artifact larger than ${maxBytes} bytes`);
      h.update(c);
      parts.push(c);
    }
    this.files.set(p, Buffer.concat(parts));
    return { sha256: h.digest('hex'), size };
  }
  async rename(a: string, b: string) {
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error('EIO');
    }
    const f = this.files.get(a);
    if (!f) throw new Error(`ENOENT ${a}`);
    this.files.set(b, f);
    this.files.delete(a);
  }
  async chmod(p: string, mode: number) {
    this.modes.set(p, mode);
  }
  async exists(p: string) {
    return this.files.has(p) || this.links.has(p);
  }
}
