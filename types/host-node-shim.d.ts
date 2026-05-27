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
  from(value: ArrayBuffer): Buffer;
  from(value: Buffer | string, encoding?: string): Buffer;
  from(value: Iterable<number> | ArrayLike<number>): Buffer;
  isBuffer(value: unknown): value is Buffer;
};

declare const process: {
  arch: string;
  env: Record<string, string | undefined>;
  execPath?: string;
  platform: string;
  pid: number;
  version: string;
  versions?: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  once(event: string, listener: (...args: any[]) => void): unknown;
  uptime(): number;
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

  export interface Cipher {
    update(data: Buffer | string, inputEncoding?: string): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  }

  export interface Decipher {
    update(data: Buffer | string): Buffer;
    final(): Buffer;
    setAuthTag(tag: Buffer): void;
  }

  export function createCipheriv(algorithm: string, key: Buffer, iv: Buffer): Cipher;
  export function createDecipheriv(algorithm: string, key: Buffer, iv: Buffer): Decipher;
  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: Buffer | string): Hmac;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function scryptSync(password: string, salt: string, keylen: number): Buffer;
  export function timingSafeEqual(a: Buffer, b: Buffer): boolean;
}

declare module 'node:child_process' {
  export interface StreamLike {
    setEncoding(encoding: string): unknown;
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  }

  export interface WritableStreamLike {
    write(data: Buffer | string): unknown;
  }

  export interface ChildProcessLike {
    stdin?: WritableStreamLike;
    stdout: StreamLike;
    stderr: StreamLike;
    kill(signal?: string): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  }

  export interface SpawnSyncResult<T = string | Buffer> {
    status?: number | null;
    stdout?: T;
    stderr?: T;
  }

  export interface ExecFileError extends Error {
    code?: number | string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  }

  export type ExecFileCallback = (error: ExecFileError | null, stdout: string | Buffer, stderr: string | Buffer) => void;

  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>
  ): SpawnSyncResult;
  export function spawn(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>
  ): ChildProcessLike;
  export function execFile(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>,
    callback?: ExecFileCallback
  ): ChildProcessLike;
  export function execFileSync(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>
  ): string | Buffer;
}

declare module 'node:util' {
  export class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean });
    decode(input?: Buffer): string;
  }
  export function promisify(fn: (...args: any[]) => unknown): any;
}

declare module 'node:fs' {
  export interface Stats {
    size: number;
    mtime: Date;
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
  export function appendFileSync(path: string, data: Buffer | string, encoding?: string): void;
  export function copyFileSync(src: string, dest: string): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean, force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function unlinkSync(path: string): void;
  export function writeFileSync(path: string, data: Buffer | string, encoding?: string): void;
  export function writeFileSync(path: string, data: Buffer | string, options?: Record<string, unknown>): void;
  export function realpathSync(path: string): string;
  export namespace realpathSync {
    export function native(path: string): string;
  }
}

declare module 'node:os' {
  export function hostname(): string;
  export function homedir(): string;
  export function tmpdir(): string;
  export function userInfo(): { username: string };
}

declare module 'node:path' {
  export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  }

  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function parse(path: string): ParsedPath;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const delimiter: string;
  export const sep: string;
}

declare module 'node:module' {
  export function createRequire(url: string): (specifier: string) => unknown;
}

declare module 'node:http' {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
    on(event: string, listener: (...args: any[]) => void): unknown;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | number | string[]): void;
    getHeader(name: string): string | number | string[] | undefined;
    writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): void;
    write(chunk: string | Buffer): void;
    end(chunk?: string | Buffer): void;
  }

  export interface AddressInfo {
    port: number;
    address: string;
    family?: string;
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): Server;
    listen(port: number, callback?: () => void): Server;
    address(): AddressInfo | string | null;
    close(callback?: (err?: Error) => void): Server;
    on(event: 'error', listener: (error: Error & { code?: string }) => void): Server;
    closeAllConnections?(): void;
  }

  export function createServer(
    listener?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): Server;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:zlib' {
  export function inflateRawSync(buffer: Buffer, options?: { maxOutputLength?: number }): Buffer;
}

declare module 'node:net' {
  export function isIP(input: string): number;
}

declare module 'node:dns' {
  export interface LookupAddress {
    address: string;
    family: number;
  }
  export namespace promises {
    function lookup(
      hostname: string,
      options: { all: true; verbatim?: boolean }
    ): Promise<LookupAddress[]>;
  }
}

declare module 'pg' {
  export interface QueryResult {
    rows?: unknown[];
    rowCount?: number | null;
  }

  export class Client {
    constructor(options?: Record<string, unknown>);
    connect(): Promise<void>;
    end(): Promise<void>;
    on(event: 'notification', listener: (message: { channel?: string; payload?: string | null }) => void): unknown;
    query(text: string, params?: unknown[]): Promise<QueryResult>;
  }

  export class Pool {
    constructor(options?: Record<string, unknown>);
    end(): Promise<void>;
    query(text: string, params?: unknown[]): Promise<QueryResult>;
  }

  const defaultExport: {
    Client: typeof Client;
    Pool: typeof Pool;
  };
  export default defaultExport;
}
