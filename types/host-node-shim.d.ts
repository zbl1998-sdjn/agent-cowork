interface Buffer {
  values(): IterableIterator<number>;
  toString(encoding?: string): string;
}

declare const Buffer: {
  byteLength(value: string, encoding?: string): number;
};

declare const process: {
  platform: string;
};

declare module 'node:crypto' {
  export interface Hash {
    update(data: Buffer | string): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: string): Hash;
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
  export function readFileSync(path: string): Buffer;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function statSync(path: string): Stats;
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
