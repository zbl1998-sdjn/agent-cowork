// Event attachment helpers for the PostgreSQL approval LISTEN connection.
import type { PostgresApprovalClientBoundary } from './postgres-approval-client.js';
import type { PgClient, PgNotification } from './postgres-approval-support.js';

type EventListener = (...args: unknown[]) => void;
type EventClient = PgClient & {
  on(event: string, handler: EventListener): unknown;
  off?(event: string, handler: EventListener): unknown;
  removeListener?(event: string, handler: EventListener): unknown;
};

export type PostgresApprovalListenerAttachment = {
  client: PgClient;
  generation: number;
  disconnected: boolean;
  notification: (message: PgNotification) => void;
  error: () => void;
  end: () => void;
};

type AttachOptions = {
  client: PgClient;
  boundary: PostgresApprovalClientBoundary;
  channel: string;
  generation: number;
  onNotification: (
    attachment: PostgresApprovalListenerAttachment,
    id: string,
  ) => void;
  onDisconnect: (
    attachment: PostgresApprovalListenerAttachment,
    event: 'error' | 'end',
  ) => void;
};

function notificationId(message: PgNotification, channel: string): string | null {
  try {
    if (message.channel && message.channel !== channel) return null;
    if (typeof message.payload !== 'string') return null;
    const parsed: unknown = JSON.parse(message.payload);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(parsed, 'id');
    return descriptor && typeof descriptor.value === 'string' && descriptor.value
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

export function detachPostgresApprovalListener(
  attachment: PostgresApprovalListenerAttachment,
): void {
  const client = attachment.client as EventClient;
  const remove = client.off?.bind(client) || client.removeListener?.bind(client);
  if (!remove) return;
  try { remove('notification', attachment.notification as EventListener); } catch { /* best effort */ }
  try { remove('error', attachment.error as EventListener); } catch { /* best effort */ }
  try { remove('end', attachment.end as EventListener); } catch { /* best effort */ }
}

export function attachPostgresApprovalListener(
  options: AttachOptions,
): PostgresApprovalListenerAttachment {
  const attachment: PostgresApprovalListenerAttachment = {
    client: options.client,
    generation: options.generation,
    disconnected: false,
    notification: (message) => {
      const id = notificationId(message, options.channel);
      if (id) options.onNotification(attachment, id);
    },
    error: () => options.onDisconnect(attachment, 'error'),
    end: () => options.onDisconnect(attachment, 'end'),
  };
  const client = options.client as EventClient;
  try {
    client.on('notification', attachment.notification as EventListener);
    client.on('error', attachment.error as EventListener);
    client.on('end', attachment.end as EventListener);
    options.boundary.handoffErrorAbsorber(options.client);
    return attachment;
  } catch {
    detachPostgresApprovalListener(attachment);
    throw new Error('PostgresApprovalStore: LISTEN client event registration failed');
  }
}
