// src/gateway/thread-run-store.ts
// In-memory workflow run status store keyed by Discord thread + run + step.

export type ThreadRunDecision = "approve" | "reject"
export type ThreadRunStatus = "pending" | "approved" | "rejected"

export interface ThreadRunRecord {
  threadId: string
  runId: string
  stepId: string
  status: ThreadRunStatus
  actorUserId: string | null
  updatedAt: string
}

export interface ThreadRunSummary {
  threadId: string
  runId: string
  totalSteps: number
  pending: number
  approved: number
  rejected: number
}

interface ThreadRunStoreOptions {
  now?: () => string
}

interface ThreadStepKey {
  threadId: string
  runId: string
  stepId: string
}

interface ApplyDecisionInput extends ThreadStepKey {
  decision: ThreadRunDecision
  actorUserId: string | null
}

export class ThreadRunStore {
  private readonly records = new Map<string, ThreadRunRecord>()
  private readonly now: () => string

  constructor(options: ThreadRunStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  touchPending(input: ThreadStepKey, actorUserId: string | null = null): ThreadRunRecord {
    const key = buildKey(input.threadId, input.runId, input.stepId)
    const existing = this.records.get(key)
    if (existing) return cloneRecord(existing)

    const created: ThreadRunRecord = {
      threadId: input.threadId,
      runId: input.runId,
      stepId: input.stepId,
      status: "pending",
      actorUserId,
      updatedAt: this.now(),
    }
    this.records.set(key, created)
    return cloneRecord(created)
  }

  applyDecision(input: ApplyDecisionInput): ThreadRunRecord {
    const status: ThreadRunStatus = input.decision === "approve" ? "approved" : "rejected"
    const key = buildKey(input.threadId, input.runId, input.stepId)
    const next: ThreadRunRecord = {
      threadId: input.threadId,
      runId: input.runId,
      stepId: input.stepId,
      status,
      actorUserId: input.actorUserId,
      updatedAt: this.now(),
    }
    this.records.set(key, next)
    return cloneRecord(next)
  }

  getStep(input: ThreadStepKey): ThreadRunRecord | null {
    const key = buildKey(input.threadId, input.runId, input.stepId)
    const record = this.records.get(key)
    return record ? cloneRecord(record) : null
  }

  listRun(threadId: string, runId: string): ThreadRunRecord[] {
    const rows: ThreadRunRecord[] = []
    for (const record of this.records.values()) {
      if (record.threadId === threadId && record.runId === runId) {
        rows.push(cloneRecord(record))
      }
    }
    rows.sort((a, b) => a.stepId.localeCompare(b.stepId))
    return rows
  }

  summarizeRun(threadId: string, runId: string): ThreadRunSummary {
    const rows = this.listRun(threadId, runId)
    const summary: ThreadRunSummary = {
      threadId,
      runId,
      totalSteps: rows.length,
      pending: 0,
      approved: 0,
      rejected: 0,
    }

    for (const row of rows) {
      if (row.status === "pending") summary.pending += 1
      if (row.status === "approved") summary.approved += 1
      if (row.status === "rejected") summary.rejected += 1
    }

    return summary
  }
}

function buildKey(threadId: string, runId: string, stepId: string): string {
  return `${threadId}::${runId}::${stepId}`
}

function cloneRecord(record: ThreadRunRecord): ThreadRunRecord {
  return { ...record }
}
