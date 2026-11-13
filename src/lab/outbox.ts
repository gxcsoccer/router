/** An in-memory Outbox that records what the Engine queued, for assertions and for the lab's reply trail. */
import type { OutboundMessage, Outbox, ReplyStatus } from '../core/index.ts'

export class MemoryOutbox implements Outbox {
  readonly messages = new Map<string, OutboundMessage>()
  /** Ids withdrawn after being queued, in order. */
  readonly withdrawn: string[] = []
  send(message: OutboundMessage): void { if (!this.messages.has(message.id)) this.messages.set(message.id, structuredClone(message)) }
  status(id: string): ReplyStatus | undefined { return this.messages.has(id) ? (this.withdrawn.includes(id) ? 'dropped' : 'pending') : undefined }
  withdraw(id: string): void { if (this.messages.has(id) && !this.withdrawn.includes(id)) this.withdrawn.push(id) }
  list(): OutboundMessage[] { return [...this.messages.values()] }
}
