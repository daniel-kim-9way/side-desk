// 핀을 «Claude가 우리 도구를 불러 줘야만» 채우지 않으려고, Claude가 평소 쓰는 할 일 도구를 옆에서 엿보고
// 답변 끝의 질문을 자동으로 «결정 대기»에 올려요. `$`를 쓰지 않는 순수 함수라 테스트가 쉬워요.
import type { Board, Todo } from './lib.ts'

const MAX_TODOS = 40
export const AUTO_DECISION_ID = 'auto'

/** 엿볼 내장 도구들 */
export const MIRRORED_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate'] as const

/** TodoWrite 는 목록 «전체»를 보내요. 그대로 옮겨요. */
function fromTodoWrite(input: Record<string, unknown>): Todo[] | undefined {
  const list = input.todos
  if (!Array.isArray(list)) return undefined
  const out: Todo[] = []
  list.forEach((t: unknown, i: number) => {
    const o = t as { content?: unknown; status?: unknown }
    if (o && typeof o.content === 'string') {
      out.push({ id: `t${i + 1}`, text: o.content, isDone: o.status === 'completed', isActive: o.status === 'in_progress' })
    }
  })
  return out.slice(-MAX_TODOS)
}

/** TaskCreate 결과에서 엔진이 붙인 번호를 찾아요. 모양을 몰라도 되게 글로 바꿔서 찾아요. 못 찾으면 undefined. */
export function findTaskId(result: unknown): string | undefined {
  let text = ''
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  } catch {
    return undefined
  }
  return /"id"\s*:\s*"?(\d+)"?/.exec(text)?.[1] ?? /#(\d{1,6})/.exec(text)?.[1]
}

/** 번호가 겹치지 않게 다음 할 일 id 를 만들어요. */
const nextId = (todos: Todo[]) => 't' + (Math.max(0, ...todos.map(t => Number(t.id.slice(1)) || 0)) + 1)

/**
 * 도구 호출 하나를 핀에 반영해요. 바뀐 게 없으면 undefined.
 *  · TodoWrite  : 목록 전체 교체
 *  · TaskCreate : 할 일 하나 추가 (엔진 번호는 결과에서 읽고, 못 읽으면 만든 순서를 써요)
 *  · TaskUpdate : taskId 로 찾아서 상태·제목 갱신 (deleted 면 뺌)
 */
export function mirrorTool(board: Board, tool: string, input: Record<string, unknown>, result: unknown): Board | undefined {
  if (tool === 'TodoWrite') {
    const todos = fromTodoWrite(input)
    return todos ? { ...board, todos } : undefined
  }
  if (tool === 'TaskCreate') {
    const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
    if (!subject) return undefined
    const ref = findTaskId(result) ?? String(board.todos.filter(t => t.ref !== undefined).length + 1)
    const todo: Todo = { id: nextId(board.todos), text: subject, isDone: false, ref }
    return { ...board, todos: [...board.todos, todo].slice(-MAX_TODOS) }
  }
  if (tool === 'TaskUpdate') {
    const ref = input.taskId === undefined ? '' : String(input.taskId)
    const i = board.todos.findIndex(t => t.ref === ref)
    if (i < 0) return undefined
    const status = input.status
    let todos = board.todos.slice()
    if (status === 'deleted') {
      todos = todos.filter((_, j) => j !== i)
    } else {
      const cur = todos[i]!
      const next: Todo = { ...cur }
      if (typeof input.subject === 'string' && input.subject.trim()) next.text = input.subject.trim()
      if (status === 'completed') {
        next.isDone = true
        next.isActive = false
      } else if (status === 'in_progress') {
        next.isDone = false
        next.isActive = true
        // 진행 중인 건 하나만 보여요.
        todos = todos.map((t, j) => (j === i ? t : { ...t, isActive: false }))
      } else if (status === 'pending') {
        next.isDone = false
        next.isActive = false
      }
      todos[i] = next
    }
    return { ...board, todos }
  }
  return undefined
}

const QUESTION_END = /[?？]\s*[*_`)"'\]»」』]*$/
// «~해 주세요», «~해 주시면 …할게요», «~할까요», «승인 후에» 처럼 내 답이나 결정을 기다리는 말
const REQUEST = /(주세요|주시면|주실래요|주시겠어요|할까요|드릴까요|괜찮을까요|어때요|승인해|결정해)/
const SCAN_LINES = 14
const MAX_ITEMS = 3

/**
 * 답변이 «내 답을 기다리는 말»을 하는지 봐요. 끝의 열네 줄 안에서 질문(물음표로 끝남)이나 요청(«~해 주세요» 따위)을
 * 최대 세 줄 찾아 한 줄로 묶어 돌려줘요. 코드 블록 안은 보지 않아요. 없으면 undefined.
 */
export function trailingQuestion(answer: string): string | undefined {
  const prose = answer.replace(/```[\s\S]*?```/g, '')
  const lines = prose.split('\n').map(l => l.trim()).filter(Boolean).slice(-SCAN_LINES)
  const picked = lines.filter(l => QUESTION_END.test(l) || REQUEST.test(l)).slice(-MAX_ITEMS)
  if (picked.length === 0) return undefined
  const clean = (l: string) => {
    const t = l.replace(/^[-*•>\d.)\s]+/, '').replace(/[*_`]/g, '')
    return t.length > 90 ? t.slice(0, 87) + '…' : t
  }
  const text = picked.map(clean).join(' / ')
  return text.length > 200 ? text.slice(0, 197) + '…' : text
}

/** 자동으로 올린 «결정 대기»를 갱신해요. question 이 없으면 자동 항목만 지워요. */
export function withAutoDecision(board: Board, question: string | undefined): Board {
  const manual = board.decisions.filter(d => d.id !== AUTO_DECISION_ID)
  return { ...board, decisions: question ? [...manual, { id: AUTO_DECISION_ID, text: question }] : manual }
}
