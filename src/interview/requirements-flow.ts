// src/interview/requirements-flow.ts
// Thread-scoped requirements interview finite state machine.

export type RequirementsPhase =
  | "PROBLEM"
  | "USERS"
  | "FEATURES"
  | "CONSTRAINTS"
  | "PRIORITIES"
  | "SUMMARY"
  | "CONFIRM"

export interface RequirementsQuestion {
  id: string
  text: string
}

export interface RequirementsAnswer {
  phase: RequirementsPhase
  questionId: string
  question: string
  answer: string
  answeredAt: string
}

export interface RequirementsSessionState {
  threadId: string
  runId: string
  phase: RequirementsPhase
  phaseIndex: number
  questionIndex: number
  completed: boolean
  createdAt: string
  updatedAt: string
  answers: RequirementsAnswer[]
}

export interface RequirementsPrompt {
  threadId: string
  runId: string
  phase: RequirementsPhase
  questionId: string
  question: string
  isLastQuestionInPhase: boolean
  isFinalPhase: boolean
}

export interface RequirementsAdvanceResult {
  accepted: boolean
  completed: boolean
  state: RequirementsSessionState
  prompt: RequirementsPrompt | null
}

interface RequirementsFlowOptions {
  now?: () => string
}

interface SessionKey {
  threadId: string
  runId: string
}

interface PhaseDefinition {
  phase: RequirementsPhase
  questions: RequirementsQuestion[]
}

const PHASES: PhaseDefinition[] = [
  {
    phase: "PROBLEM",
    questions: [
      { id: "problem_outcome", text: "What outcome do you want this workflow to produce?" },
      { id: "problem_trigger", text: "What event should start the workflow?" },
    ],
  },
  {
    phase: "USERS",
    questions: [
      { id: "users_actor", text: "Who will run or monitor this workflow?" },
      { id: "users_audience", text: "Who consumes the output?" },
    ],
  },
  {
    phase: "FEATURES",
    questions: [
      { id: "features_must", text: "List the must-have capabilities." },
      { id: "features_optional", text: "List nice-to-have capabilities." },
      { id: "features_gate", text: "Where do you need human approval gates?" },
    ],
  },
  {
    phase: "CONSTRAINTS",
    questions: [
      { id: "constraints_data", text: "What systems or data sources must be used?" },
      { id: "constraints_policy", text: "What policy, security, or compliance constraints apply?" },
      { id: "constraints_deadline", text: "What deadlines or SLA targets matter?" },
    ],
  },
  {
    phase: "PRIORITIES",
    questions: [
      { id: "priorities_rank", text: "Rank what matters most: speed, quality, cost, or safety." },
      { id: "priorities_fallback", text: "What tradeoff is acceptable when conflicts happen?" },
    ],
  },
  {
    phase: "SUMMARY",
    questions: [
      { id: "summary_review", text: "Review the draft summary. What should be corrected?" },
    ],
  },
  {
    phase: "CONFIRM",
    questions: [
      { id: "confirm_ready", text: "Confirm: should we lock this spec and proceed? (yes/no)" },
    ],
  },
]

export class RequirementsFlow {
  private readonly sessions = new Map<string, RequirementsSessionState>()
  private readonly now: () => string

  constructor(options: RequirementsFlowOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  start(threadId: string, runId: string): RequirementsPrompt {
    const state = this.getOrCreateSession(threadId, runId)
    return this.getCurrentPrompt(state)
  }

  answer(threadId: string, runId: string, answer: string): RequirementsAdvanceResult {
    const state = this.getOrCreateSession(threadId, runId)
    if (state.completed) {
      return {
        accepted: false,
        completed: true,
        state: cloneState(state),
        prompt: null,
      }
    }

    const phaseDef = PHASES[state.phaseIndex]
    const question = phaseDef.questions[state.questionIndex]
    const trimmed = answer.trim()
    if (trimmed.length === 0) {
      return {
        accepted: false,
        completed: false,
        state: cloneState(state),
        prompt: this.getCurrentPrompt(state),
      }
    }

    state.answers.push({
      phase: phaseDef.phase,
      questionId: question.id,
      question: question.text,
      answer: trimmed,
      answeredAt: this.now(),
    })

    const inPhaseHasMore = state.questionIndex + 1 < phaseDef.questions.length
    if (inPhaseHasMore) {
      state.questionIndex += 1
      state.updatedAt = this.now()
      this.sessions.set(keyOf(threadId, runId), state)
      return {
        accepted: true,
        completed: false,
        state: cloneState(state),
        prompt: this.getCurrentPrompt(state),
      }
    }

    const hasMorePhases = state.phaseIndex + 1 < PHASES.length
    if (!hasMorePhases) {
      state.completed = true
      state.updatedAt = this.now()
      this.sessions.set(keyOf(threadId, runId), state)
      return {
        accepted: true,
        completed: true,
        state: cloneState(state),
        prompt: null,
      }
    }

    state.phaseIndex += 1
    state.phase = PHASES[state.phaseIndex].phase
    state.questionIndex = 0
    state.updatedAt = this.now()
    this.sessions.set(keyOf(threadId, runId), state)

    return {
      accepted: true,
      completed: false,
      state: cloneState(state),
      prompt: this.getCurrentPrompt(state),
    }
  }

  hasSession(threadId: string, runId: string): boolean {
    return this.sessions.has(keyOf(threadId, runId))
  }

  getState(threadId: string, runId: string): RequirementsSessionState | null {
    const state = this.sessions.get(keyOf(threadId, runId))
    return state ? cloneState(state) : null
  }

  listAnswers(threadId: string, runId: string): RequirementsAnswer[] {
    const state = this.sessions.get(keyOf(threadId, runId))
    if (!state) return []
    return state.answers.map((answer) => ({ ...answer }))
  }

  buildSummary(threadId: string, runId: string): string {
    const state = this.sessions.get(keyOf(threadId, runId))
    if (!state) return "No requirements captured yet."

    const groups = new Map<RequirementsPhase, RequirementsAnswer[]>()
    for (const phase of PHASES) groups.set(phase.phase, [])
    for (const row of state.answers) groups.get(row.phase)!.push(row)

    const lines: string[] = []
    lines.push(`Run ${runId} requirements summary:`)
    for (const phase of PHASES) {
      if (phase.phase === "CONFIRM") continue
      const answers = groups.get(phase.phase) ?? []
      if (answers.length === 0) continue
      lines.push(`${phase.phase}:`)
      for (const item of answers) lines.push(`- ${item.question}: ${item.answer}`)
    }
    return lines.join("\n")
  }

  private getOrCreateSession(threadId: string, runId: string): RequirementsSessionState {
    const key = keyOf(threadId, runId)
    const existing = this.sessions.get(key)
    if (existing) return existing

    const created: RequirementsSessionState = {
      threadId,
      runId,
      phase: PHASES[0].phase,
      phaseIndex: 0,
      questionIndex: 0,
      completed: false,
      createdAt: this.now(),
      updatedAt: this.now(),
      answers: [],
    }
    this.sessions.set(key, created)
    return created
  }

  private getCurrentPrompt(state: RequirementsSessionState): RequirementsPrompt {
    const phaseDef = PHASES[state.phaseIndex]
    const question = phaseDef.questions[state.questionIndex]
    return {
      threadId: state.threadId,
      runId: state.runId,
      phase: phaseDef.phase,
      questionId: question.id,
      question: question.text,
      isLastQuestionInPhase: state.questionIndex === phaseDef.questions.length - 1,
      isFinalPhase: state.phaseIndex === PHASES.length - 1,
    }
  }
}

function keyOf(threadId: string, runId: string): string {
  return `${threadId}::${runId}`
}

function cloneState(state: RequirementsSessionState): RequirementsSessionState {
  return {
    ...state,
    answers: state.answers.map((row) => ({ ...row })),
  }
}
