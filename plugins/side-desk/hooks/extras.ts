// 0.3.0 에 더한 순수 함수들: 오늘 일정 · 이번 대화에서 고친 파일 · 명령어 안내 · 처음 설정 점검 · 승인 대기 알림.
// ft-desk 와 side-desk 가 이 파일을 똑같이 써요. 한쪽을 고치면 다른 쪽에도 그대로 복사해요.
// `$`를 쓰지 않아서 테스트가 쉬워요.

const pad2 = (n: number) => String(n).padStart(2, '0')
const dayText = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// ───────────── 오늘 일정 (claude.ai Google Calendar 커넥터, 읽기만) ─────────────

/** Claude Code 에 연결된 구글 캘린더 커넥터 이름. /mcp 에 이 이름으로 보여요. */
export const CALENDAR_SERVER = 'claude.ai Google Calendar'

export type CalEvent = {
  id: string
  title: string
  day: 'today' | 'tomorrow'
  allDay: boolean
  start?: number
  end?: number
  location: string
}

/** now 가 속한 날(addDays 만큼 옮긴 날)의 0시, ms */
function midnight(now: number, addDays = 0): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + addDays)
  return d
}

/** 그날 0시를 «2026-10-15T00:00:00»처럼 시간대 없이 써요. 커넥터가 계정의 시간대로 읽어요. */
export const localMidnight = (now: number, addDays = 0) => `${dayText(midnight(now, addDays))}T00:00:00`

/** list_events 에 넘길 값: 오늘 0시부터 모레 0시까지(오늘·내일), 시작 시각 순. */
export function calendarArgs(now: number) {
  return { startTime: localMidnight(now), endTime: localMidnight(now, 2), orderBy: 'startTime', pageSize: 30 }
}

/**
 * list_events 결과 → 오늘·내일 일정. 취소된 일정은 빼요.
 * 어제 시작해서 오늘까지 이어지는 일정(며칠짜리 종일 일정 포함)은 오늘 일정으로 봐요.
 * 순서: 오늘 먼저, 같은 날 안에서는 종일 일정 먼저, 그다음 시작 시각 순.
 */
export function parseEvents(data: unknown, now: number): CalEvent[] {
  const list = (data as { events?: unknown } | undefined)?.events
  if (!Array.isArray(list)) return []
  const today = dayText(midnight(now))
  const tomorrow = dayText(midnight(now, 1))
  const todayStart = midnight(now).getTime()
  const out: CalEvent[] = []
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object' || raw.status === 'cancelled') continue
    const s = (raw.start ?? {}) as { dateTime?: unknown; date?: unknown }
    const e = (raw.end ?? {}) as { dateTime?: unknown; date?: unknown }
    let day: string
    let start: number | undefined
    let end: number | undefined
    const allDay = typeof s.dateTime !== 'string' && typeof s.date === 'string'
    if (allDay) {
      day = s.date as string
      // 종일 일정의 end.date 는 끝난 «다음 날»이에요.
      if (day < today && typeof e.date === 'string' && e.date > today) day = today
    } else if (typeof s.dateTime === 'string') {
      start = Date.parse(s.dateTime)
      if (Number.isNaN(start)) continue
      const parsedEnd = typeof e.dateTime === 'string' ? Date.parse(e.dateTime) : NaN
      end = Number.isNaN(parsedEnd) ? undefined : parsedEnd
      day = dayText(new Date(start))
      if (day < today && end !== undefined && end > todayStart) day = today
    } else {
      continue
    }
    const which = day === today ? 'today' : day === tomorrow ? 'tomorrow' : undefined
    if (which === undefined) continue
    const title = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : '(제목 없음)'
    out.push({ id: String(raw.id ?? ''), title, day: which, allDay, start, end, location: typeof raw.location === 'string' ? raw.location.trim() : '' })
  }
  const rank = (ev: CalEvent) => (ev.day === 'today' ? 0 : 2) + (ev.allDay ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || (a.start ?? 0) - (b.start ?? 0))
}

/** «09:30» 또는 «종일». 오늘 시작하지 않고 어제부터 이어지는 일정은 «~11:00»(끝나는 시각)이에요. */
export function eventTime(ev: CalEvent, now: number): string {
  if (ev.allDay || ev.start === undefined) return '종일'
  const hm = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`
  if (ev.day === 'today' && ev.start < midnight(now).getTime()) return ev.end !== undefined ? `~${hm(ev.end)}` : '종일'
  return hm(ev.start)
}

/** 끝난 일정인지(흐리게 그려요) */
export const eventEnded = (ev: CalEvent, now: number) => ev.end !== undefined && ev.end <= now

// ───────────── 이번 대화에서 고친 파일 ─────────────

export type Change = { path: string; count: number; at: number }

/** 파일을 고친 도구들 */
export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** 고친 도구 호출의 경로. 경로가 없으면 undefined. */
export function editedPath(input: unknown): string | undefined {
  const i = (input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
  const p = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : ''
  return p.trim() ? p.replace(/\\/g, '/') : undefined
}

/** 고친 파일 하나를 목록 맨 위로 올려요. 같은 파일은 한 줄로 합치고 횟수를 세요. 50개까지만 둬요. */
export function addChange(list: readonly Change[], path: string, at: number): Change[] {
  const norm = path.replace(/\\/g, '/')
  const key = norm.toLowerCase()
  const prev = list.find(c => c.path.toLowerCase() === key)
  return [{ path: norm, count: (prev?.count ?? 0) + 1, at }, ...list.filter(c => c.path.toLowerCase() !== key)].slice(0, 50)
}

type MsgLike = { toolUses: readonly { tool: string; input: Record<string, unknown>; isError?: boolean }[] }

/** 저장해 둔 목록이 없을 때(이 기능이 생기기 전 대화) 대화 기록에서 한 번 만들어요. 시각은 모르니 0이에요. */
export function changesFromMessages(messages: readonly MsgLike[]): Change[] {
  let out: Change[] = []
  for (const m of messages) {
    for (const t of m.toolUses ?? []) {
      if (!(EDIT_TOOLS as readonly string[]).includes(t.tool) || t.isError) continue
      const p = editedPath(t.input)
      if (p) out = addChange(out, p, 0)
    }
  }
  return out
}

/** 화면에 쓸 이름: 파일 이름과 폴더. 작업 폴더 안이면 폴더를 그 안의 상대 경로로 줄여요. */
export function changeLabel(path: string, root: string): { name: string; dir: string } {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const cut = p.lastIndexOf('/')
  const name = cut >= 0 ? p.slice(cut + 1) : p
  let dir = cut >= 0 ? p.slice(0, cut) : ''
  if (r !== '') {
    const low = dir.toLowerCase()
    const rl = r.toLowerCase()
    if (low === rl) dir = ''
    else if (low.startsWith(rl + '/')) dir = dir.slice(r.length + 1)
  }
  return { name, dir }
}

/** «>» 를 누르면 입력창에 넣는 글 */
export const changePrompt = (path: string) => `이번 대화에서 ${path} 파일을 왜, 어떻게 바꿨는지 쉽게 설명해 줘.`

// ───────────── 명령어 안내 ─────────────

export type Guide = { name: string; arg?: string; text: string }

/**
 * 처음 쓰는 사람이 자주 찾는 명령. 모두 이 모드가 요구하는 버전(MIN_VERSION)부터 있는 기본 명령이에요.
 * ($.command.list 로 거르지 않아요. 화면 없는 실행에서는 /resume·/rewind 같은 대화형 명령이 목록에서 빠져서요)
 * 누르면 입력창에 넣기만 하고, 실행은 엔터로 해요(/clear 처럼 되돌릴 수 없는 것도 있어서요).
 */
export const COMMAND_GUIDE: readonly Guide[] = [
  { name: 'clear', text: '대화를 비우고 새로 시작해요' },
  { name: 'compact', text: '지금까지 대화를 요약해서 줄여요' },
  { name: 'resume', text: '지난 대화를 골라서 이어 가요' },
  { name: 'rewind', text: '대화와 고친 파일을 앞 시점으로 되돌려요' },
  { name: 'model', text: '쓰는 모델을 바꿔요' },
  { name: 'context', text: '대화 용량을 무엇이 차지하는지 봐요' },
  { name: 'usage', text: '요금제 한도를 얼마나 썼는지 봐요' },
  { name: 'mcp', text: 'Gmail·캘린더 같은 커넥터를 연결하고 로그인해요' },
  { name: 'permissions', text: '묻지 않고 쓸 도구를 정해요' },
  { name: 'memory', text: 'Claude가 늘 읽는 지침 파일(CLAUDE.md)을 고쳐요' },
  { name: 'tui', arg: 'fullscreen', text: '책상을 옆에 붙이고 마우스로 누를 수 있게 해요' },
  { name: 'doctor', text: '설치에 문제가 없는지 점검해요' },
  { name: 'help', text: '명령 전체 목록을 봐요' },
]

export const guideCommand = (g: Guide) => `/${g.name}${g.arg ? ' ' + g.arg : ''}`

// ───────────── 처음 설정 점검 ─────────────

/** 이 모드가 기대는 기능(옆 창·훅 모양)이 들어온 첫 Claude Code 버전 */
export const MIN_VERSION = '2.1.287'

/** v 가 min 이상인지. 버전을 못 읽으면 undefined. */
export function versionAtLeast(v: string, min: string): boolean | undefined {
  const parse = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1).map(Number)
  const a = parse(v)
  const b = parse(min)
  if (!a || !b) return undefined
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}

/** ok = ✓ · bad = ✗(고치는 법이 있어요) · na = 이 환경에선 해당 없음 · wait = 확인 중 */
export type Check = { id: string; label: string; state: 'ok' | 'bad' | 'na' | 'wait'; detail: string; fix?: string }

export const CHECK_MARK: Record<Check['state'], string> = { ok: '✓', bad: '✗', na: '–', wait: '…' }

/**
 * 커넥터(Gmail·캘린더)를 불러 본 결과 → 점검 한 줄. problem 이 없으면 됨.
 * 거절 이유로 «연결 안 됨 / 권한 없음 / 로그인 풀림»을 가려서 고치는 법을 달리 적어요.
 */
export function connectorCheck(id: string, label: string, server: string, tools: readonly string[], problem: string | undefined, okDetail = '연결됨'): Check {
  if (problem === undefined) return { id, label, state: 'ok', detail: okDetail }
  const p = problem.replace(/\s+/g, ' ').trim()
  if (/haven't granted|permission|권한/i.test(p)) {
    return { id, label, state: 'bad', detail: '연결은 됐는데 읽는 권한을 아직 안 받았어요', fix: `/permissions 에서 ${tools.join(', ')} 허용` }
  }
  if (/auth|login|token|expired|로그인/i.test(p) && !/not connected|no connected/i.test(p)) {
    return { id, label, state: 'bad', detail: '로그인이 풀렸어요', fix: `/mcp 에서 «${server}»를 골라 다시 로그인` }
  }
  return { id, label, state: 'bad', detail: '연결이 안 돼 있어요', fix: `/mcp 에서 «${server}» 연결 (목록에 없으면 claude.ai 설정 > 커넥터에서 먼저 추가)` }
}

// ───────────── 승인 기다릴 때 알림 ─────────────

/**
 * Claude Code 가 «이 도구를 써도 될까요?» 창을 띄울 때 보낼 알림. 알림을 안 보낼 도구면 undefined.
 *  · AskUserQuestion 은 질문 알림이 따로 있어서 빼요.
 */
export function permissionNote(tool: string, input: unknown): { title: string; body: string } | undefined {
  if (tool === 'AskUserQuestion') return undefined
  if (tool === 'ExitPlanMode') return { title: '계획 승인을 기다려요', body: 'Claude가 세운 계획을 보고 승인해 주세요' }
  const i = (input ?? {}) as Record<string, unknown>
  const what = [i.command, i.file_path, i.notebook_path, i.url, i.pattern].find(v => typeof v === 'string' && v.trim()) as string | undefined
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
  const body = name + (what ? `: ${what.replace(/\s+/g, ' ').trim()}` : '')
  return { title: '승인을 기다려요', body: body.length > 120 ? body.slice(0, 117) + '…' : body }
}
