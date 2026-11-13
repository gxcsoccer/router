/**
 * A minimal Policy for the lab: the gate admits an addressed message from an allowed sender with `explicit` strength, and
 * anything else as `inferred`. It is deliberately simpler than dsh-superagent's rule engine — the routing mechanism under
 * test does not depend on how the gate decides, only on the strength it returns.
 */
import type { GateResult, Mandate, Policy, Trigger } from '../core/index.ts'

export interface LabPolicyOptions {
  version?: string
  paused?: boolean
  /** Long by default: the lab drives Evals synchronously, so nothing should expire mid-experiment. */
  evalTimeoutMs?: number
  /** Senders that may originate work; every other sender is refused by the gate. */
  allowed?: readonly string[]
  /** Whether an inferred candidate may be accepted on its matched rules (the `auto` accept mode). */
  admitInferred?: boolean
  /** Revalidation of a Mandate before an ended ticket may resume; `true` by default. */
  revalidate?: (mandate: Mandate) => boolean
}

export function createPolicy(options: LabPolicyOptions = {}): Policy {
  const allowed = new Set(options.allowed ?? ['user'])
  const version = options.version ?? 'lab-policy-1'
  return {
    version,
    paused: options.paused ?? false,
    evalTimeoutMs: options.evalTimeoutMs ?? 10 * 60 * 1000,
    gate(trigger: Trigger): GateResult {
      if (!allowed.has(trigger.actor.id)) return { admissible: false, reason: 'senderNotMember' }
      return trigger.addressed
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: trigger.addressed } }
        : { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    },
    revalidate: options.revalidate ?? (() => true),
    admitsInferred: (rules: readonly string[]) => (options.admitInferred ?? false) && rules.length > 0,
  }
}
