import { JsonlWriter } from '../storage/jsonl-writer.js';
import type { OrchestrationEvent } from './types.js';

export type TraceRecorderOptions = {
  eventsPath?: string;
};

export class TraceRecorder {
  readonly eventsPath: string;
  private readonly writer: JsonlWriter | null;
  private readonly events: OrchestrationEvent[] = [];

  constructor({ eventsPath = '' }: TraceRecorderOptions = {}) {
    this.eventsPath = eventsPath;
    this.writer = eventsPath ? new JsonlWriter(eventsPath) : null;
  }

  append(event: OrchestrationEvent): OrchestrationEvent {
    const stored = JSON.parse(JSON.stringify(event)) as OrchestrationEvent;
    this.events.push(stored);
    this.writer?.append(stored);
    return stored;
  }

  list(): OrchestrationEvent[] {
    return this.events.map((event) => JSON.parse(JSON.stringify(event)) as OrchestrationEvent);
  }
}
