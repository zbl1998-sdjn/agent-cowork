interface Buffer extends Iterable<number> {
  readonly length: number;
  readonly [index: number]: number;
  readUInt16LE(offset: number): number;
  readUInt32LE(offset: number): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  writeUInt16LE(value: number, offset: number): number;
  writeUInt32LE(value: number, offset: number): number;
  values(): IterableIterator<number>;
  toString(encoding?: string): string;
}

declare const Buffer: {
  alloc(size: number): Buffer;
  byteLength(value: string, encoding?: string): number;
  concat(list: readonly Buffer[]): Buffer;
  from(value: Buffer | string, encoding?: string): Buffer;
  from(value: Iterable<number> | ArrayLike<number>): Buffer;
  isBuffer(value: unknown): value is Buffer;
};

declare const process: {
  platform: string;
  pid: number;
  cwd(): string;
};

declare module 'node:crypto' {
  export interface Hash {
    update(data: Buffer | string): Hash;
    digest(): Buffer;
    digest(encoding: 'hex'): string;
  }

  export interface Hmac {
    update(data: Buffer | string): Hmac;
    digest(): Buffer;
    digest(encoding: 'hex' | 'base64'): string;
  }

  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: Buffer | string): Hmac;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function timingSafeEqual(a: Buffer, b: Buffer): boolean;
}

declare module 'node:fs' {
  export interface Stats {
    size: number;
    mtimeMs: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function statSync(path: string): Stats;
  export function unlinkSync(path: string): void;
  export function writeFileSync(path: string, data: Buffer | string, encoding?: string): void;
  export function realpathSync(path: string): string;
  export namespace realpathSync {
    export function native(path: string): string;
  }
}

declare module 'node:path' {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:zlib' {
  export function inflateRawSync(buffer: Buffer, options?: { maxOutputLength?: number }): Buffer;
}
