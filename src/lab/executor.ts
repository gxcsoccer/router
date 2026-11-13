/**
 * A recording Executor. dsh-superagent launches a DSH Session per Ticket; the lab records what it would have launched so the
 * driver can act as that worker. Every method only queues work, exactly as the port requires.
 */
import type { Assignment, Executor, Ticket } from '../core/index.ts'

export type ExecutorCommand =
  | { kind: 'start'; ticketId: string; assignmentId: string }
  | { kind: 'deliver'; ticketId: string; assignmentId: string }
  | { kind: 'stop'; ticketId: string; assignmentId: string; reason: string }

export class RecordingExecutor implements Executor {
  readonly commands: ExecutorCommand[] = []
  start(ticket: Ticket, assignment: Assignment): void {
    this.commands.push({ kind: 'start', ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.commands.push({ kind: 'deliver', ticketId: ticket.id, assignmentId: assignment.id })
  }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.commands.push({ kind: 'stop', ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  take(): ExecutorCommand[] { return this.commands.splice(0, this.commands.length) }
}
