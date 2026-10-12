import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, link, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export class SettingsError extends Error {
  readonly code: 'invalid-config' | 'settings-unavailable';
  constructor(code: 'invalid-config' | 'settings-unavailable') {
    super(code);
    this.code = code;
  }
}
const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
function unavailable(error: unknown): never {
  throw error instanceof SettingsError ? error : new SettingsError('settings-unavailable');
}
function bound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new SettingsError('invalid-config');
}
async function checkParent(path: string): Promise<void> {
  try {
    const stat = await lstat(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SettingsError('settings-unavailable');
  } catch (error) { if (!missing(error)) unavailable(error); }
}
async function regularFile(path: string): Promise<FileHandle | undefined> {
  await checkParent(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SettingsError('settings-unavailable');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new SettingsError('settings-unavailable');
      return file;
    } catch (error) { await file.close(); throw error; }
  } catch (error) {
    if (missing(error)) return undefined;
    return unavailable(error);
  }
}
export async function readSettingsBytes(path: string, maxBytes: number): Promise<Buffer | undefined> {
  bound(maxBytes);
  const file = await regularFile(path);
  if (!file) return undefined;
  try {
    if ((await file.stat()).size > maxBytes) throw new SettingsError('invalid-config');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new SettingsError('invalid-config');
    return buffer.subarray(0, length);
  } catch (error) { return unavailable(error); }
  finally { await file.close(); }
}
export type Scope = 'global' | 'project';
export type SettingsPaths = Record<Scope, string>;
export function settingsPaths(cwd: string, agentDir: string, filename: string): SettingsPaths {
  return { global: join(agentDir, filename), project: join(cwd, '.pi', filename) };
}
export async function loadScopedSettings<T extends object>(
  paths: SettingsPaths, trusted: boolean, maxBytes: number, parse: (value: unknown) => T,
): Promise<{ settings: T; sources: Partial<Record<keyof T, Scope>> }> {
  const read = async (path: string): Promise<T> => {
    const value = decodeSettings(await readSettingsBytes(path, maxBytes));
    try { return parse(value); } catch { throw new SettingsError('invalid-config'); }
  };
  const global = await read(paths.global);
  const project = trusted ? await read(paths.project) : {} as T;
  const settings = { ...global, ...project };
  const sources: Partial<Record<keyof T, Scope>> = {};
  for (const key of Object.keys(settings) as (keyof T)[]) sources[key] = Object.hasOwn(project, key) ? 'project' : 'global';
  return { settings, sources };
}
export function decodeSettings(raw: Buffer | undefined): unknown {
  if (raw === undefined) return {};
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new SettingsError('invalid-config'); }
}
/** Raw repair checkpoints do not decode or retain the complete old file. */
async function fingerprint(path: string): Promise<string | undefined> {
  const file = await regularFile(path);
  if (!file) return undefined;
  try {
    const hash = createHash('sha256'), chunk = Buffer.alloc(65536);
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally { await file.close(); }
}
function serialize(value: unknown, maxBytes: number): string {
  bound(maxBytes);
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new SettingsError('invalid-config');
  const text = json + '\n';
  if (Buffer.byteLength(text) > maxBytes) throw new SettingsError('invalid-config');
  return text;
}
type Checkpoint = { text: string; exists: boolean; unchanged: () => Promise<boolean> };

/** Caller owns the host queue. The exclusive lock covers read, update, and commit. */
async function transaction(path: string, prepare: () => Promise<Checkpoint>): Promise<void> {
  let lock: FileHandle | undefined, ownedTemp = false;
  const lockPath = path + '.lock', temp = path + '.' + randomUUID() + '.tmp';
  try {
    await checkParent(path);
    await mkdir(dirname(path), { recursive: true });
    await checkParent(path);
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const checkpoint = await prepare();
    const output = await open(temp, 'wx', 0o600);
    ownedTemp = true;
    try { await output.writeFile(checkpoint.text, 'utf8'); await output.sync(); }
    finally { await output.close(); }
    if (!(await checkpoint.unchanged())) throw new SettingsError('settings-unavailable');
    if (checkpoint.exists) await rename(temp, path);
    else await link(temp, path);
  } catch (error) { unavailable(error); }
  finally {
    try {
      if (ownedTemp) {
        try { await unlink(temp); } catch (error) { if (!missing(error)) unavailable(error); }
      }
    } finally {
      if (lock) {
        try {
          const owned = await lock.stat(), current = await lstat(lockPath);
          if (owned.ino !== current.ino || owned.dev !== current.dev || current.isSymbolicLink()) throw new SettingsError('settings-unavailable');
          await unlink(lockPath);
        } finally { await lock.close(); }
      }
    }
  }
}
/** Update only valid JSON. The synchronous callback supplies schema and merge policy. */
export async function updateJsonSettings(path: string, maxBytes: number, update: (value: unknown) => unknown): Promise<void> {
  bound(maxBytes);
  await transaction(path, async () => {
    const before = await readSettingsBytes(path, maxBytes);
    const text = serialize(update(decodeSettings(before)), maxBytes);
    return { text, exists: before !== undefined, unchanged: async () => {
      const current = await readSettingsBytes(path, maxBytes);
      return before === undefined ? current === undefined : current !== undefined && current.equals(before);
    } };
  });
}
/** Explicit replacement repairs malformed regular files. It never follows symlinks. */
export async function replaceJsonSettings(path: string, value: unknown, maxBytes: number): Promise<void> {
  const text = serialize(value, maxBytes);
  await transaction(path, async () => {
    const before = await fingerprint(path);
    return { text, exists: before !== undefined, unchanged: async () => (await fingerprint(path)) === before };
  });
}
