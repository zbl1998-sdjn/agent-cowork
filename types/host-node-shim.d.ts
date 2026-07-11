interface Buffer extends Uint8Array {
  readonly length: number;
  readonly [index: number]: number;
  readUInt16LE(offset: number): number;
  readUInt16BE(offset: number): number;
  readInt16BE(offset: number): number;
  readUInt32BE(offset: number): number;
  readUInt32LE(offset: number): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  includes(value: Buffer | string | number): boolean;
  write(value: string, offset?: number, encoding?: string): number;
  writeUInt16LE(value: number, offset: number): number;
  writeUInt16BE(value: number, offset: number): number;
  writeInt16BE(value: number, offset: number): number;
  writeUInt32LE(value: number, offset: number): number;
  writeUInt32BE(value: number, offset: number): number;
  values(): IterableIterator<number>;
  toString(encoding?: string, start?: number, end?: number): string;
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
  argv: string[];
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode?: number;
  platform: string;
  pid: number;
  stderr: { write(data: Buffer | string): unknown };
  stdin: {
    setEncoding(encoding: string): unknown;
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
  stdout: { write(data: Buffer | string): unknown };
  version: string;
  versions?: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): boolean;
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
    pid?: number;
    stdin?: WritableStreamLike;
    stdout: StreamLike;
    stderr: StreamLike;
    kill(signal?: string): void;
    unref(): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  }

  export interface SpawnSyncResult<T = string | Buffer> {
    status?: number | null;
    signal?: string | null;
    stdout?: T;
    stderr?: T;
    error?: Error;
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
  export function spawnSync(
    command: string,
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
  export const types: {
    isProxy(value: unknown): boolean;
  };
  export class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean });
    decode(input?: Buffer): string;
  }
  export function promisify(fn: (...args: any[]) => unknown): any;
}

declare module 'node:timers/promises' {
  export function setTimeout(delay?: number, value?: unknown): Promise<unknown>;
}

declare module 'node:fs' {
  export type PathLike = string | Buffer | URL;
  export type PathOrFileDescriptor = PathLike | number;

  export interface Stats {
    dev: number;
    ino: number;
    mode: number;
    size: number;
    mtime: Date;
    mtimeMs: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function existsSync(path: PathLike): boolean;
  export function appendFileSync(path: string, data: Buffer | string, encoding?: string): void;
  export function closeSync(fd: number): void;
  export function copyFileSync(src: string, dest: string): void;
  export function fsyncSync(fd: number): void;
  export function fstatSync(fd: number): Stats;
  export function linkSync(existingPath: PathLike, newPath: PathLike): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function renameSync(oldPath: PathLike, newPath: PathLike): void;
  export function rmdirSync(path: PathLike): void;
  export function rmSync(path: string, options?: { recursive?: boolean, force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function unlinkSync(path: PathLike): void;
  export function utimesSync(
    path: PathLike,
    atime: string | number | Date,
    mtime: string | number | Date
  ): void;
  export function writeFileSync(path: string, data: Buffer | string, encoding?: string): void;
  export function writeFileSync(path: string, data: Buffer | string, options?: Record<string, unknown>): void;
  export function realpathSync(path: string): string;
  export namespace realpathSync {
    export function native(path: string): string;
  }
  export namespace promises {
    export function readFile(path: string, encoding: string): Promise<string>;
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

  export function basename(path: string, suffix?: string): string;
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

declare module 'node:perf_hooks' {
  export const performance: {
    now(): number;
  };
}

declare module 'node:module' {
  export function createRequire(url: string): (specifier: string) => unknown;
  export function register(specifier: string | URL, parentURL?: string | URL): void;
}

declare module 'node:http' {
  export interface ClientRequest {
    on(event: 'error', listener: (error: Error) => void): ClientRequest;
    setTimeout(timeout: number, callback?: () => void): ClientRequest;
    destroy(error?: Error): void;
    write(chunk: string | Buffer): boolean;
    end(chunk?: string | Buffer): void;
  }

  export interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    family?: number;
    autoSelectFamily?: boolean;
    lookup?: (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
  }

  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
    statusCode?: number;
    setEncoding(encoding: string): void;
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
    once(event: 'error', listener: (error: Error & { code?: string }) => void): Server;
    closeAllConnections?(): void;
  }

  export function createServer(
    listener?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): Server;
  export function get(url: string, callback?: (response: IncomingMessage) => void): ClientRequest;
  export function request(
    url: URL,
    options: RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ): ClientRequest;
}

declare module 'node:https' {
  import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
  export function request(
    url: URL,
    options: RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ): ClientRequest;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:vm' {
  export class Script {
    constructor(code: string, options?: { filename?: string; displayErrors?: boolean });
  }
}

declare module 'node:zlib' {
  export function inflateRawSync(buffer: Buffer, options?: { maxOutputLength?: number }): Buffer;
  export function deflateSync(buffer: Buffer): Buffer;
}

declare module 'node:net' {
  export interface Server {
    listen(port: number, host: string, callback?: () => void): Server;
    address(): import('node:http').AddressInfo | string | null;
    close(callback?: () => void): Server;
    once(event: 'error', listener: (error: Error) => void): Server;
  }

  export function createServer(): Server;
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

declare module 'node:test' {
  export interface TestContext { skip(message?: string): void }
  export interface TestFunction { (context: TestContext): unknown | Promise<unknown> }
  export interface TestOptions { only?: boolean; skip?: boolean | string; todo?: boolean | string; timeout?: number }
  export default function test(name: string, fn: TestFunction): unknown;
  export default function test(name: string, options: TestOptions, fn: TestFunction): unknown;
}

declare module 'node:assert/strict' {
  export interface Assert {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    throws(block: () => unknown, validator?: RegExp | ((error: unknown) => boolean), message?: string): void;
    rejects(
      block: () => unknown | Promise<unknown>,
      validator?: RegExp | ((error: unknown) => boolean),
      message?: string
    ): Promise<void>;
    doesNotThrow(block: () => unknown, message?: string): void;
    doesNotMatch(actual: string, expected: RegExp, message?: string): void;
  }

  const assert: Assert;
  export default assert;
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
