// @ts-check
import childProcess from 'node:child_process';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { runConstrainedChild } from './exec-child.js';

// Local subprocess sandbox adapter.
//
// Runs a normalised SandboxSpec as a constrained child process on the host:
//   - no shell (argv array; spec values cannot inject shell syntax)
//   - cwd jailed to the trusted root
//   - sanitised environment (only the spec's allowlisted env is passed)
//   - hard timeout (SIGKILL) + output byte cap  (see exec-child.js)
//
// Honesty note: a plain host subprocess CANNOT enforce network isolation. This
// adapter therefore always reports `networkIsolated: false` and surfaces a
// warning when `network` was requested off. True isolation is the job of the
// VM adapter (WSL2/Docker), which shares the same `exec(spec, ctx)` interface.

/**
 * @typedef {import('./sandbox-spec.js').SandboxSpec} SandboxSpec
 * @typedef {import('./exec-child.js').SpawnLike} SpawnLike
 * @typedef {{ trustedRoot?: string, context?: Record<string, unknown> }} SandboxExecContext
 * @typedef {{ backend: string, exitCode: number, signal: string | null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, bytesStdout: number, bytesStderr: number, durationMs: number, networkIsolated: boolean, warnings: string[] }} SandboxExecResult
 */

export class LocalSubprocessSandbox {
  /** @param {{ spawn?: SpawnLike }} [options] */
  constructor({ spawn = childProcess.spawn } = {}) {
    this.backend = 'local-subprocess';
    this.networkIsolated = false;
    this._spawn = spawn;
  }

  /** @param {SandboxSpec} spec @param {SandboxExecContext} [ctx] @returns {Promise<SandboxExecResult>} */
  async exec(spec, ctx = {}) {
    const trustedRoot = ctx.trustedRoot;
    if (!trustedRoot) {
      throw new Error('LocalSubprocessSandbox.exec: trustedRoot is required');
    }
    const requestedCwd = spec.cwd ? spec.cwd : trustedRoot;
    const safeCwd = assertTrustedPath(requestedCwd, trustedRoot);

    /** @type {string[]} */
    const warnings = [];
    if (!spec.network) {
      warnings.push('local backend cannot enforce network isolation; use the vm backend for a true no-network guarantee');
    }

    /** @type {Record<string, string>} */
    const env = { ...spec.env };
    if (process.env.PATH) {
      env.PATH = env.PATH ? `${env.PATH}${path.delimiter}${process.env.PATH}` : process.env.PATH;
    }
    if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

    const core = await runConstrainedChild({
      spawn: this._spawn,
      command: spec.tool,
      args: spec.args,
      cwd: safeCwd,
      env,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
    });

    return {
      backend: this.backend,
      ...core,
      networkIsolated: false,
      warnings,
    };
  }
}
