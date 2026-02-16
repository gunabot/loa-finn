// tests/finn/thread-run-store.test.ts

import assert from "node:assert/strict"
import { ThreadRunStore } from "../../src/gateway/thread-run-store.js"

const tests: { name: string; fn: () => void | Promise<void> }[] = []

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

test("touchPending creates a pending step record", () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T10:00:00.000Z" })
  const row = store.touchPending({ threadId: "thread-1", runId: "run-1", stepId: "gate-1" })

  assert.equal(row.threadId, "thread-1")
  assert.equal(row.runId, "run-1")
  assert.equal(row.stepId, "gate-1")
  assert.equal(row.status, "pending")
  assert.equal(row.updatedAt, "2026-02-16T10:00:00.000Z")
})

test("applyDecision records approve/reject states", () => {
  let tick = 0
  const timestamps = [
    "2026-02-16T10:00:00.000Z",
    "2026-02-16T10:01:00.000Z",
    "2026-02-16T10:02:00.000Z",
  ]
  const store = new ThreadRunStore({ now: () => timestamps[tick++] ?? timestamps[timestamps.length - 1] })

  store.touchPending({ threadId: "thread-2", runId: "run-2", stepId: "gate-a" })
  const approved = store.applyDecision({
    threadId: "thread-2",
    runId: "run-2",
    stepId: "gate-a",
    decision: "approve",
    actorUserId: "user-42",
  })

  assert.equal(approved.status, "approved")
  assert.equal(approved.actorUserId, "user-42")
  assert.equal(approved.updatedAt, "2026-02-16T10:01:00.000Z")

  const rejected = store.applyDecision({
    threadId: "thread-2",
    runId: "run-2",
    stepId: "gate-b",
    decision: "reject",
    actorUserId: "user-9",
  })

  assert.equal(rejected.status, "rejected")
  assert.equal(rejected.stepId, "gate-b")
  assert.equal(rejected.updatedAt, "2026-02-16T10:02:00.000Z")
})

test("summarizeRun returns counts by status", () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T10:05:00.000Z" })

  store.touchPending({ threadId: "thread-3", runId: "run-3", stepId: "a" })
  store.applyDecision({
    threadId: "thread-3",
    runId: "run-3",
    stepId: "b",
    decision: "approve",
    actorUserId: "user-1",
  })
  store.applyDecision({
    threadId: "thread-3",
    runId: "run-3",
    stepId: "c",
    decision: "reject",
    actorUserId: "user-2",
  })

  const summary = store.summarizeRun("thread-3", "run-3")
  assert.equal(summary.totalSteps, 3)
  assert.equal(summary.pending, 1)
  assert.equal(summary.approved, 1)
  assert.equal(summary.rejected, 1)
})

test("listRun is scoped by thread and sorted by stepId", () => {
  const store = new ThreadRunStore({ now: () => "2026-02-16T10:10:00.000Z" })

  store.touchPending({ threadId: "thread-4", runId: "run-4", stepId: "z-step" })
  store.touchPending({ threadId: "thread-4", runId: "run-4", stepId: "a-step" })
  store.touchPending({ threadId: "thread-other", runId: "run-4", stepId: "x-step" })

  const rows = store.listRun("thread-4", "run-4")
  assert.equal(rows.length, 2)
  assert.equal(rows[0].stepId, "a-step")
  assert.equal(rows[1].stepId, "z-step")
})

async function main() {
  let failures = 0
  console.log("Thread Run Store Tests")
  console.log("======================")

  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`  PASS  ${name}`)
    } catch (err) {
      failures += 1
      console.error(`  FAIL  ${name}`)
      console.error(err)
    }
  }

  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error("fatal test harness error", err)
  process.exitCode = 1
})
