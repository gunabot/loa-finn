// tests/finn/requirements-flow.test.ts

import assert from "node:assert/strict"
import { RequirementsFlow } from "../../src/interview/requirements-flow.js"

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

function makeFlow() {
  let counter = 0
  return new RequirementsFlow({
    now: () => `2026-02-16T12:20:${String(counter++).padStart(2, "0")}.000Z`,
  })
}

test("start initializes interview at PROBLEM phase", () => {
  const flow = makeFlow()
  const prompt = flow.start("thread-1", "run-1")

  assert.equal(prompt.phase, "PROBLEM")
  assert.equal(prompt.questionId, "problem_outcome")
  assert.ok(prompt.question.length > 0)
})

test("blank answer is rejected and phase does not advance", () => {
  const flow = makeFlow()
  flow.start("thread-1", "run-1")
  const result = flow.answer("thread-1", "run-1", "   ")

  assert.equal(result.accepted, false)
  assert.equal(result.completed, false)
  assert.equal(result.state.phase, "PROBLEM")
  assert.equal(result.state.questionIndex, 0)
})

test("phase advances after final question in a phase", () => {
  const flow = makeFlow()
  flow.start("thread-1", "run-1")

  const first = flow.answer("thread-1", "run-1", "Outcome answer")
  assert.equal(first.accepted, true)
  assert.equal(first.completed, false)
  assert.equal(first.prompt?.phase, "PROBLEM")
  assert.equal(first.prompt?.questionId, "problem_trigger")

  const second = flow.answer("thread-1", "run-1", "Trigger answer")
  assert.equal(second.accepted, true)
  assert.equal(second.completed, false)
  assert.equal(second.prompt?.phase, "USERS")
  assert.equal(second.prompt?.questionId, "users_actor")
})

test("full interview can complete and generates summary", () => {
  const flow = makeFlow()
  flow.start("thread-2", "run-2")

  let guard = 0
  let completed = false
  while (!completed && guard < 30) {
    const result = flow.answer("thread-2", "run-2", `answer-${guard + 1}`)
    completed = result.completed
    guard += 1
  }

  assert.equal(completed, true)
  const state = flow.getState("thread-2", "run-2")
  assert.equal(state?.completed, true)
  assert.equal(state?.answers.length, 14)

  const summary = flow.buildSummary("thread-2", "run-2")
  assert.ok(summary.includes("Run run-2 requirements summary"))
  assert.ok(summary.includes("PROBLEM:"))
  assert.ok(summary.includes("USERS:"))
  assert.ok(summary.includes("FEATURES:"))
})

test("sessions are keyed by threadId + runId", () => {
  const flow = makeFlow()
  flow.start("thread-a", "run-1")
  flow.answer("thread-a", "run-1", "answer A")

  flow.start("thread-a", "run-2")
  const answersRun1 = flow.listAnswers("thread-a", "run-1")
  const answersRun2 = flow.listAnswers("thread-a", "run-2")

  assert.equal(answersRun1.length, 1)
  assert.equal(answersRun2.length, 0)
})

async function main() {
  let failures = 0
  console.log("Requirements Flow Tests")
  console.log("=======================")

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
