import type { PgClient } from './postgres-approval-support.js';
import type { PostgresApprovalClientBoundary } from './postgres-approval-client.js';
import { attachPostgresApprovalListener, detachPostgresApprovalListener } from './postgres-approval-listener.js';
import type { PostgresApprovalListenerAttachment as Attachment } from './postgres-approval-listener.js';
type ConnectionOptions = {
  boundary: PostgresApprovalClientBoundary;
  channel: string;
  reconnectAttempts: number;
  reconnectDelayMs: number;
  onNotification: (id: string) => void; onListening: () => void;
  onError: (message: string) => void;
};

const lifecycleError = (message: string): Error => new Error(`PostgresApprovalStore: ${message}`);

export class PostgresApprovalConnection {
  private readonly _boundary: PostgresApprovalClientBoundary;
  private readonly _channel: string;
  private readonly _reconnectAttempts: number;
  private readonly _reconnectDelayMs: number;
  private readonly _onNotification: (id: string) => void; private readonly _onListening: () => void;
  private readonly _onError: (message: string) => void;
  private _attachment: Attachment | null = null;
  private _started = false;
  private _stopping = false;
  private _generation = 0;
  private _startPromise: Promise<void> | null = null;
  private _reconnectPromise: Promise<void> | null = null;
  private _reconnecting = false;
  private _stopPromise: Promise<void> | null = null;
  private _wakeBackoff: (() => void) | null = null;

  constructor(options: ConnectionOptions) {
    this._boundary = options.boundary;
    this._channel = options.channel;
    this._reconnectAttempts = options.reconnectAttempts;
    this._reconnectDelayMs = options.reconnectDelayMs;
    this._onNotification = options.onNotification; this._onListening = options.onListening;
    this._onError = options.onError;
  }

  private _report(message: string): void { try { this._onError(message); } catch { /* best effort */ } }

  private _detach(attachment: Attachment): void {
    detachPostgresApprovalListener(attachment);
    if (this._attachment === attachment) this._attachment = null;
  }

  private _handleNotification(attachment: Attachment, id: string): void {
    if (
      this._attachment === attachment
      && !this._stopping
      && !attachment.disconnected
      && attachment.generation === this._generation
    ) {
      this._onNotification(id);
    }
  }

  private _attach(client: PgClient, generation: number): Attachment {
    if (this._attachment?.client === client) return this._attachment;
    const attachment = attachPostgresApprovalListener({
      client,
      boundary: this._boundary,
      channel: this._channel,
      generation,
      onNotification: (current, id) => this._handleNotification(current, id),
      onDisconnect: (current, event) => this._handleDisconnect(current, event),
    });
    this._attachment = attachment;
    return attachment;
  }

  private _handleDisconnect(attachment: Attachment, event: 'error' | 'end'): void {
    if (this._attachment !== attachment || attachment.disconnected) return;
    attachment.disconnected = true;
    this._started = false;
    this._report(`PostgresApprovalStore: LISTEN client ${event}`);
    if (
      this._stopping
      || attachment.generation !== this._generation
      || this._startPromise
      || !this._boundary.owns(attachment.client)
      || this._reconnecting
    ) {
      return;
    }
    this._reconnecting = true;
    const generation = this._generation;
    const reconnect = this._runReconnect(attachment, generation)
      .finally(() => {
        if (this._reconnectPromise === reconnect) this._reconnectPromise = null;
        this._reconnecting = false;
      });
    this._reconnectPromise = reconnect;
    void reconnect.catch(() => undefined);
  }

  private async _retireOwned(client: PgClient, attachment: Attachment | null): Promise<void> {
    try {
      await this._boundary.releaseOwnedClient(client);
    } catch {
      this._report('PostgresApprovalStore: owned LISTEN client shutdown failed');
    } finally {
      if (attachment) this._detach(attachment);
      this._started = false;
    }
  }

  private async _backoff(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this._wakeBackoff === wake) this._wakeBackoff = null;
        resolve();
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        if (this._wakeBackoff === wake) this._wakeBackoff = null;
        resolve();
      };
      this._wakeBackoff = wake;
    });
  }

  private _isCurrent(generation: number): boolean { return !this._stopping && generation === this._generation; }

  private async _runReconnect(initial: Attachment, generation: number): Promise<void> {
    await this._retireOwned(initial.client, initial);
    for (let attempt = 1; attempt <= this._reconnectAttempts; attempt += 1) {
      await this._backoff(this._reconnectDelayMs * attempt);
      if (!this._isCurrent(generation)) return;
      let client: PgClient | null = null;
      let attachment: Attachment | null = null;
      try {
        client = await this._boundary.listenerClient();
        if (!this._isCurrent(generation)) {
          await this._boundary.releaseOwnedClient(client);
          return;
        }
        attachment = this._attach(client, generation);
        await this._boundary.queryClient(client, 'LISTEN', `LISTEN ${this._channel}`);
        if (!this._isCurrent(generation) || attachment.disconnected) {
          await this._retireOwned(attachment.client, attachment);
          return;
        }
        try { this._onListening(); } catch { this._report('PostgresApprovalStore: LISTEN catch-up callback failed'); }
        this._started = true;
        return;
      } catch {
        this._report(`PostgresApprovalStore: LISTEN reconnect attempt ${attempt} failed`);
        if (client) await this._retireOwned(client, attachment);
      }
    }
    if (this._isCurrent(generation)) {
      this._report(
        `PostgresApprovalStore: LISTEN reconnect exhausted after ${this._reconnectAttempts} attempts`,
      );
    }
  }

  private async _runStart(generation: number): Promise<void> {
    const client = await this._boundary.listenerClient();
    if (!this._isCurrent(generation)) {
      if (this._boundary.owns(client)) await this._boundary.releaseOwnedClient(client);
      throw lifecycleError('stopped during start');
    }
    let attachment: Attachment | null = null;
    try {
      attachment = this._attach(client, generation);
      await this._boundary.queryClient(client, 'LISTEN', `LISTEN ${this._channel}`);
      if (!this._isCurrent(generation) || attachment.disconnected) {
        throw lifecycleError('stopped during start');
      }
      try { this._onListening(); } catch { this._report('PostgresApprovalStore: LISTEN catch-up callback failed'); }
      this._started = true;
    } catch (error) {
      this._started = false;
      if (this._boundary.owns(client)) await this._retireOwned(client, attachment);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this._stopping) throw lifecycleError('connection lifecycle is stopped');
    if (this._started) return;
    if (this._startPromise) return this._startPromise;
    if (this._reconnectPromise) {
      await this._reconnectPromise;
      if (!this._started) throw lifecycleError('LISTEN reconnect did not recover');
      return;
    }
    const generation = this._generation;
    const starting = this._runStart(generation);
    this._startPromise = starting;
    try {
      await starting;
    } finally {
      if (this._startPromise === starting) this._startPromise = null;
    }
  }

  private async _runStop(): Promise<void> {
    this._stopping = true;
    this._generation += 1;
    this._started = false;
    this._wakeBackoff?.();
    await Promise.allSettled([
      this._startPromise || Promise.resolve(),
      this._reconnectPromise || Promise.resolve(),
    ]);
    const attachment = this._attachment;
    const errors: unknown[] = [];
    if (attachment) {
      try {
        await this._boundary.queryClient(
          attachment.client,
          'UNLISTEN',
          `UNLISTEN ${this._channel}`,
        );
      } catch (error) {
        errors.push(error);
      }
      if (this._boundary.owns(attachment.client)) {
        try {
          await this._boundary.releaseOwnedClient(attachment.client);
        } catch (error) {
          errors.push(error);
        } finally {
          this._detach(attachment);
        }
      } else {
        this._detach(attachment);
      }
    }
    this._boundary.disable();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'PostgresApprovalStore: LISTEN shutdown failed');
    }
  }

  stop(): Promise<void> {
    if (this._stopPromise) return this._stopPromise;
    const stopping = this._runStop();
    this._stopPromise = stopping;
    return stopping;
  }
}
