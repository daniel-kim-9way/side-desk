import type { EngineInterface, Register } from 'claude-code'
import {
  CLIP_LIST_SCRIPT, CLIP_SCRIPT, CLIP_WATCH_SCRIPT, COACH_SKIP, COACH_SYSTEM, WINDOW_LABEL, clipInsertText, clipItemScript, clipRowText, parseClip, parseClipList,
  applyUpdate, assembleBrief, bar, briefPrompt, burn, describeBoard, extractFacts,
  hoursText, isValidBrief, k, keptShare, parseVerdict, recentTurns, seedText, untilText,
} from './lib.ts'
import type { Board, Clip, ClipItem, Decision, Todo, Update, UsageWindow, Verdict } from './lib.ts'
import { judgeSend, summarizeArgs } from './send-check.ts'
import { MIRRORED_TOOLS, mirrorTool, trailingQuestion, withAutoDecision } from './mirror.ts'

// side-desk: Claude Code 옆에 «책상» 하나를 열어 줘요.
//  · 핀      : 이번 대화의 할 일과, 내가 정해야 하는 것을 옆에 고정해 둬요
//  · 사용    : 사용 한도와 대화 길이, 비용을 한눈에
//  · 인계    : 대화가 길어지면 이어가기 메모를 쓰고 새 대화로 넘겨요 (인터넷 전송·웹 서버 없음)
//  · 클립    : 윈도우 클립보드 기록을 보고 입력창에 바로 붙여요
//  · 설정    : 발송 전 확인 · 알림 · 프롬프트 가이드
// 화면이 있는 세션에서만 묻고 움직여요. SIDE_DESK_OFF=1 이면 전부 꺼요.

const PANE = 'side-desk'
const TOOL = 'mcp__side-desk__pin'
const BRIEF_DIR = '.claude/state/side-desk/briefs'

type TabName = 'pin' | 'usage' | 'handoff' | 'clip' | 'settings'
type Mode = 'ask' | 'auto' | 'off'
type Snapshot = {
  windows: UsageWindow[]
  costUsd: number | null
  startedAt: number
  updatedAt: number
  ctxTokens?: number
  ctxWindow?: number
  ctxPercent?: number
}
type Pending = { oldSession: string; briefPath: string; tokens: number; board: Board; problem?: string }
type Cfg = {
  warnAt: number
  handoffMode: Mode
  handoffTokens: number
  handoffPercent: number
  maxUnattended: number
  coach: boolean
  coachModel: string
  sendConfirm: boolean
  notify: boolean
  notifyMinSeconds: number
  autoOpen: 'always' | 'off'
  paneColumns: number
}

const DEFAULTS: Cfg = {
  warnAt: 80,
  handoffMode: 'ask',
  handoffTokens: 400_000,
  handoffPercent: 50,
  maxUnattended: 2,
  coach: false,
  coachModel: 'haiku',
  sendConfirm: true,
  notify: true,
  notifyMinSeconds: 60,
  autoOpen: 'off',
  paneColumns: 40,
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
const asMode = (v: unknown, fallback: Mode): Mode => (v === 'ask' || v === 'auto' || v === 'off' ? v : fallback)

function parseConfig(o: Record<string, unknown>): Cfg {
  return {
    warnAt: num(o.warnAt, DEFAULTS.warnAt),
    handoffMode: asMode(typeof o.handoffMode === 'string' ? o.handoffMode.trim() : undefined, DEFAULTS.handoffMode),
    handoffTokens: num(o.handoffTokens, DEFAULTS.handoffTokens),
    handoffPercent: num(o.handoffPercent, DEFAULTS.handoffPercent),
    maxUnattended: num(o.maxUnattended, DEFAULTS.maxUnattended),
    coach: str(o.coach, 'off').toLowerCase() === 'on',
    coachModel: str(o.coachModel, DEFAULTS.coachModel),
    sendConfirm: str(o.sendConfirm, 'on').toLowerCase() !== 'off',
    notify: str(o.notify, 'on').toLowerCase() !== 'off',
    notifyMinSeconds: num(o.notifyMinSeconds, DEFAULTS.notifyMinSeconds),
    autoOpen: str(o.autoOpen, 'off').toLowerCase() === 'always' ? 'always' : 'off',
    paneColumns: Math.max(30, Math.min(120, Math.round(num(o.paneColumns, DEFAULTS.paneColumns)))),
  }
}

// ───────────── 모듈 변수 (/clear 를 건너 살아남아요) ─────────────
let cfg: Cfg = DEFAULTS
let mode: Mode = DEFAULTS.handoffMode
let coachOn = false
let sendConfirmOn = true
let notifyOn = true
let tab: TabName = 'pin'
// 시작할 때 저절로 열린 창인지. 내가 /desk 로 연 창은 아니에요.
let openedByUser = false // /desk 로 직접 연 적이 있는지
let inlineClosed = false // 입력창 위에 열린 창을 이미 한 번 닫았는지
let snap: Snapshot | undefined
let baseline: { at: number; windows: UsageWindow[] } | null = null
let turnCount = 0
const warned = new Set<string>()
let board: Board = { todos: [], decisions: [] }
let pending: Pending | undefined
let inFlight = false
let unattended = 0
let pausedSession: string | undefined
let lastBrief: { path: string; at: number; tokens: number; problem?: string } | undefined
// 클립보드: «클립» 탭을 보고 있는 동안에만 감시하고, 따로 기록하지 않아요.
// 이전 항목은 윈도우가 가진 클립보드 기록(Win+V)을 읽어서 보여 줘요.
let clip: Clip | undefined
let clipAt = 0
let clipList: ClipItem[] = []
let clipNote: string | undefined
let clipBusy = false
let clipSig = ''
let clipWatching = false
// 이어가기로 시작한 대화와, 그 대화의 시작 크기(토큰)
let seededSession: string | undefined
let seedFloor: number | undefined
const MIN_GROWTH = 150_000
// 발송 확인 기록. 최근 30개만 둬요. allow=내가 허락 · refuse=내가 거절 · unattended=화면이 없어서 보내지 않음
type SendEntry = { at: number; kind: 'allow' | 'refuse' | 'unattended'; label: string; detail: string }
let sendLog: SendEntry[] = []

const emptyBoard = (): Board => ({ todos: [], decisions: [] })
const copyBoard = (b: Board): Board => JSON.parse(JSON.stringify(b)) as Board
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const MODE_LABEL: Record<Mode, string> = { ask: '물어보고 넘기기', auto: '자동으로 넘기기', off: '끔' }
const nextMode = (m: Mode): Mode => (m === 'ask' ? 'auto' : m === 'auto' ? 'off' : 'ask')
const SEND_KIND: Record<SendEntry['kind'], string> = { allow: '보냄', refuse: '보내지 않음', unattended: '화면 없어서 막음' }

// ───────────── `$`를 받는 함수들 (`$`는 이 파일 안의 최상위 함수에만 넘겨요) ─────────────

// 화면이 없는 실행(claude -p)이나 SIDE_DESK_OFF 가 걸린 곳에서는 묻지 않고 조용히 있어요.
async function isInteractive($: EngineInterface): Promise<boolean> {
  if (await $.env.get('SIDE_DESK_OFF')) return false
  try {
    const surfaces = await $.session.surfaces()
    return surfaces.some((s: string) => s === 'terminal' || s === 'desktop')
  } catch {
    return false
  }
}

// 클립보드를 읽어요. 윈도우는 powershell, WSL은 윈도우 쪽 powershell.exe 가 읽어요.
// 이미지는 윈도우의 ~/.claude/state/side-desk/clips 에 png 로 저장해요(하루 뒤 지워져요).
async function readClipboard($: EngineInterface): Promise<Clip> {
  try {
    const ps = await powershellFor($)
    if (!ps) {
      clip = { kind: 'error', message: '이 환경에서는 클립보드를 읽지 못해요(윈도우에서만 돼요)' }
    } else {
      const run = await $.process.run([ps, '-NoProfile', '-STA', '-Command', CLIP_SCRIPT], { timeoutMs: 15000 })
      clip = run.exitCode === 0 ? parseClip(run.stdout) : { kind: 'error', message: (run.stderr || `종료 코드 ${run.exitCode}`).trim().slice(0, 160) }
    }
  } catch (err) {
    clip = { kind: 'error', message: String(err).slice(0, 160) }
  }
  clipAt = Date.now()
  return clip
}

// 어디서 돌고 있는지. WSL 안인지는 WSL이 스스로 넣는 WSL_DISTRO_NAME 으로 먼저 봐요.
// 터미널 앱이 윈도우의 환경 변수(OS=Windows_NT 등)를 WSL 셸에 그대로 넘기는 일이 있어서, OS 변수만으로는 믿을 수 없어요.
async function hostKind($: EngineInterface): Promise<'windows' | 'wsl' | 'other'> {
  if (await $.env.get('WSL_DISTRO_NAME')) return 'wsl'
  return (await $.env.get('OS')) === 'Windows_NT' ? 'windows' : 'other'
}

// 윈도우 쪽 PowerShell 실행 파일. 윈도우는 powershell, WSL은 윈도우 쪽 powershell.exe(PATH가 막혀 있어도 되게 전체 경로를 먼저 써요).
async function powershellFor($: EngineInterface): Promise<string | undefined> {
  const kind = await hostKind($)
  if (kind === 'windows') return 'powershell'
  if (kind !== 'wsl') return undefined
  const abs = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  try {
    if (await $.fs.exists(abs)) return abs
  } catch {
    // 확인이 안 되면 PATH 에 있는 이름을 써 봐요.
  }
  return 'powershell.exe'
}

// 읽어 온 기록(parsed)을 목록에 반영해요. 바뀌었으면 true.
// 윈도우 기록이 꺼져 있거나 못 읽었으면 지금 클립보드 한 개만 보여 줘요.
async function applyClipParsed($: EngineInterface, parsed: { items: ClipItem[]; problem?: string }): Promise<boolean> {
  if (parsed.items.length > 0) {
    clipList = parsed.items
    clipNote = undefined
  } else {
    const cur = await readClipboard($)
    const at = new Date()
    const stamp = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    clipList =
      cur.kind === 'text'
        ? [{ id: 'current', at: stamp, kind: 'text', chars: cur.chars, preview: cur.text.slice(0, 300) }]
        : cur.kind === 'image'
          ? [{ id: 'current', at: stamp, kind: 'image' }]
          : []
    clipNote = parsed.problem
      ? '윈도우 클립보드 기록을 못 읽어서 지금 것만 보여요. (설정 > 시스템 > 클립보드 > 클립보드 기록을 켜면 목록이 나와요)'
      : '클립보드가 비어 있어요.'
  }
  clipAt = Date.now()
  const sig = clipList.map(i => i.id).join(',') + '|' + (clipNote ?? '')
  const changed = sig !== clipSig
  clipSig = sig
  return changed
}

// «새로 읽기»를 눌렀을 때 한 번만 읽어요. 자동으로는 부르지 않아요.
async function readClipList($: EngineInterface): Promise<boolean> {
  if (clipBusy) return false
  clipBusy = true
  try {
    const ps = await powershellFor($)
    if (!ps) {
      clipList = []
      clipNote = '이 환경에서는 클립보드를 읽지 못해요. (윈도우에서만 돼요)'
      return true
    }
    const run = await $.process.run([ps, '-NoProfile', '-STA', '-Command', CLIP_LIST_SCRIPT], { timeoutMs: 15000 })
    const parsed = run.exitCode === 0 ? parseClipList(run.stdout) : { items: [] as ClipItem[], problem: (run.stderr || `종료 코드 ${run.exitCode}`).trim().slice(0, 120) }
    return await applyClipParsed($, parsed)
  } catch (err) {
    clipList = []
    clipNote = `못 읽었어요: ${String(err).slice(0, 100)}`
    return true
  } finally {
    clipBusy = false
  }
}

// 목록의 한 항목을 입력창에 붙여요. 전체 내용은 이때 따로 가져와요(목록에는 앞 300자만 있어요).
async function pasteItem($: EngineInterface, item: ClipItem): Promise<void> {
  if (item.kind === 'other') {
    $.ui.toast('글이나 이미지가 아니라서 붙일 수 없어요.', { timeoutMs: 5000 })
    return
  }
  if (item.id === 'current') {
    await pasteClip($, await readClipboard($))
    return
  }
  const script = clipItemScript(item.id)
  const ps = await powershellFor($)
  if (!script || !ps) {
    $.ui.toast('이 항목은 붙일 수 없어요.', { timeoutMs: 5000 })
    return
  }
  try {
    const run = await $.process.run([ps, '-NoProfile', '-STA', '-Command', script], { timeoutMs: 20000 })
    await pasteClip($, run.exitCode === 0 ? parseClip(run.stdout) : { kind: 'error', message: (run.stderr || `종료 코드 ${run.exitCode}`).trim().slice(0, 120) })
  } catch (err) {
    $.ui.toast(`붙이지 못했어요: ${String(err).slice(0, 100)}`, { timeoutMs: 6000 })
  }
}

// 클립보드가 바뀌는 걸 «듣는» 감시 프로세스를 한 번만 띄워요. (프로세스를 계속 새로 만들지 않아요)
//  · 프로세스 하나가 클립보드 번호만 0.7초마다 확인하고, 바뀌었을 때만 목록을 내보내요.
//  · 옆 창이 안 보이거나 «클립» 탭이 아닌 채로 1분이 지나면 이 반복문을 끝내고, 그러면 프로세스도 같이 끝나요.
//  · 모드가 내려가거나 세션이 끝나도 프로세스는 같이 끝나요.
async function watchClipboard($: EngineInterface): Promise<void> {
  if (clipWatching) return
  clipWatching = true
  let idle = 0
  try {
    const ps = await powershellFor($)
    if (!ps) return
    let buf = ''
    let acc: string[] | undefined
    for await (const piece of $.process.spawn({ argv: [ps, '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', CLIP_WATCH_SCRIPT] })) {
      if (piece.stream !== 'stdout') continue
      buf += piece.text
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line === 'BEGIN') {
          acc = []
        } else if (line === 'END') {
          if (acc && (await applyClipParsed($, parseClipList(acc.join('\n'))))) $.ui.invalidate('ui.render')
          acc = undefined
        } else if (line === 'TICK') {
          // 10초마다: 옆 창이 보이고 «클립» 탭이 선택돼 있는지 물어요. 1분(6번) 동안 아니면 끝내요.
          const panes = await $.ui.panes().catch(() => [])
          const visible = tab === 'clip' && panes.some(p => p.id === PANE && p.isShown && p.isPlaced)
          idle = visible ? 0 : idle + 1
          if (idle >= 6) return
        } else if (acc) {
          acc.push(line)
        }
      }
    }
  } catch (err) {
    // 감시를 못 띄워도 «새로 읽기»는 돼요. 화면이 «읽는 중…»에서 멈추지 않게 이유를 보여 줘요.
    clipNote = `클립보드 감시를 시작하지 못했어요: ${String(err).slice(0, 120)}`
    $.ui.invalidate('ui.render')
  } finally {
    clipWatching = false
    if (clipAt === 0 && clipNote === undefined) {
      clipNote = '클립보드 목록을 받지 못했어요. «새로 읽기»를 눌러 보세요.'
      $.ui.invalidate('ui.render')
    }
  }
}

// 읽어 둔 클립보드를 입력창의 커서 자리에 끼워 넣어요. 이미지는 파일 경로가 들어가요.
async function pasteClip($: EngineInterface, c: Clip): Promise<boolean> {
  if (c.kind === 'empty' || c.kind === 'error') {
    $.ui.toast(c.kind === 'empty' ? '클립보드가 비어 있어요.' : `클립보드를 못 읽었어요: ${c.message}`, { timeoutMs: 6000 })
    return false
  }
  const inWsl = (await hostKind($)) === 'wsl'
  // Claude가 읽을 수 있는 경로로: 윈도우는 슬래시로, WSL은 C:\… 를 /mnt/c/… 로 바꿔요.
  const toHost = (p: string) => {
    const slashed = p.replace(/\\/g, '/')
    if (!inWsl) return slashed
    const m = /^([A-Za-z]):\/(.*)$/.exec(slashed)
    return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]}` : slashed
  }
  const text = clipInsertText(c, toHost)
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (!filled.isFilled) $.ui.toast('입력창에 못 넣었어요. 창이 열려 있을 때 다시 해 주세요.', { timeoutMs: 6000 })
  return filled.isFilled
}

// 세션을 시작할 때 책상을 옆에 열어 둬요. 기본은 꺼져 있어요(autoOpen: always 로 켤 수 있어요).
// 키보드 포커스는 가져오지 않아서, 바로 입력창에 쓸 수 있어요.
let autoTried = false // 이 프로세스에서 자동으로 한 번 열어 봤는지. 닫은 걸 다시 열지 않으려고요.
async function autoOpenDesk($: EngineInterface) {
  try {
    if (autoTried) return
    if (cfg.autoOpen === 'off') return
    if (!(await isInteractive($))) return
    autoTried = true
    await refreshUsage($)
    updateStatus($)
    if (tab === 'clip') void watchClipboard($)
    const opened = await $.ui.open({ id: PANE, title: '책상', columns: cfg.paneColumns, closeOnEscape: true })
    if (opened && opened.isPlaced === false) {
      // 저절로 연 창은 터미널이 144칸 미만이면 그려지지 않고 기다려요. 이유를 보여 줘요.
      const why = String((opened as { reason?: unknown }).reason ?? '')
      $.ui.toast(`책상을 아직 못 그렸어요(${why}). /desk 를 치면 바로 열려요.`, { timeoutMs: 15000 })
    }
  } catch (err) {
    // 옆 창이 안 열려도 대화는 그대로 해요.
    $.ui.log(`책상을 자동으로 열지 못했어요: ${String(err)}`)
    $.ui.toast(`책상을 자동으로 열지 못했어요: ${String(err)}`, { timeoutMs: 15000 })
  }
}

// 윈도우는 HOME 이 아니라 USERPROFILE 을 써요.
async function homeDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  return home.replace(/\\/g, '/')
}

// ───────────── 알림 · 발송 전 확인 ─────────────

function recordSend(kind: SendEntry['kind'], label: string, detail: string) {
  sendLog = [{ at: Date.now(), kind, label, detail: detail.slice(0, 160) }, ...sendLog].slice(0, 30)
}

// 윈도우 알림(풍선). 화면이 있는 세션에서, 알림이 켜져 있을 때만 띄워요.
async function osNotify($: EngineInterface, title: string, body: string) {
  // 기다리지 않고 부르는 함수라서 어떤 오류도 밖으로 새면 안 돼요. 알림이 안 떠도 일은 그대로 해요.
  try {
    if (!notifyOn || !(await isInteractive($))) return
    const exe = await powershellFor($)
    if (!exe) return
    // 알림 글이 PowerShell 문자열을 깨지 않도록 따옴표·달러·괄호 등을 빼요.
    const safe = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/["'`$\\;|&<>(){}]/g, ' ').slice(0, 120)
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      `$n.ShowBalloonTip(6000, '${safe(title)}', '${safe(body) || ' '}', 'Info')`,
      'Start-Sleep -Seconds 7',
      '$n.Dispose()',
    ].join('; ')
    void $.process.run([exe, '-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { timeoutMs: 20000 }).catch(() => {})
  } catch {
    // 위와 같아요.
  }
}

// «보내기/보내지 않기»를 물어요. 창을 닫거나 다른 답을 쓰면 보내지 않는 쪽으로 봐요.
let asking = false
async function confirmWith($: EngineInterface, question: string, yes: string, no: string): Promise<boolean> {
  void osNotify($, '확인이 필요해요', question.split('\n')[0] ?? '')
  asking = true
  try {
    const answer = await $.ui.ask(question, { header: '발송 확인', options: [yes, no] })
    return answer === yes
  } catch {
    return false
  } finally {
    asking = false
  }
}

// 도구 호출 한 건이 «바깥으로 나가는 일»이면 보내기 전에 물어요. 막을 때만 { deny }를 돌려줘요.
async function sendCheck($: EngineInterface, e: Record<string, unknown>): Promise<{ deny: string } | undefined> {
  if (!sendConfirmOn) return undefined
  const j = judgeSend(String(e.tool ?? ''))
  if (!j) return undefined
  if (!(await isInteractive($))) {
    // 화면 없는 실행(예약 작업 등): 확인해 줄 사람이 없으니 보내지 않아요.
    recordSend('unattended', j.label, j.detail)
    return { deny: `${j.reason} 확인해 줄 사람이 화면에 없어서 보내지 않았어요.` }
  }
  const question = `바깥으로 나가요. 보낼까요?\n\n${j.label}\n${summarizeArgs(e) || j.detail}\n\n${j.reason}`
  const ok = await confirmWith($, question, '보내기', '보내지 않기')
  recordSend(ok ? 'allow' : 'refuse', j.label, j.detail)
  if (ok) return undefined
  return { deny: '사용자가 보내지 않기로 했어요. 같은 내용을 다시 보내지 말고, 무엇을 고칠지 먼저 물어보세요.' }
}

async function refreshUsage($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const windows: UsageWindow[] = usage.rateLimits.map((w: UsageWindow) => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    snap = {
      windows,
      costUsd: usage.cost?.usd ?? null,
      startedAt: usage.startedAt,
      updatedAt: now,
      ctxTokens: usage.context?.tokens,
      ctxWindow: usage.context?.window,
      ctxPercent: usage.context?.percent,
    }
    baseline ??= { at: now, windows }
  } catch {
    // 사용량을 못 읽으면 지난 값을 그대로 둬요.
  }
}

function statusLine(): string {
  const parts: string[] = []
  const five = snap?.windows.find(w => w.kind === 'five_hour')
  if (five) parts.push(`5시간 ${Math.round(five.percentUsed)}%`)
  if (snap?.ctxPercent !== undefined) parts.push(`대화 ${Math.round(snap.ctxPercent)}%`)
  const open = board.todos.filter(t => !t.isDone).length
  if (open > 0) parts.push(`할 일 ${open}`)
  if (board.decisions.length > 0) parts.push(`결정 ${board.decisions.length}`)
  return parts.join(' · ')
}

function updateStatus($: EngineInterface) {
  const line = statusLine()
  $.ui.status(line === '' ? undefined : line)
}

// 핀은 대화(세션)마다 따로 두고, 가장 최근 30개만 남겨요.
type StoredBoards = Record<string, { at: number; todos: Todo[]; decisions: Decision[] }>

async function loadBoard($: EngineInterface) {
  try {
    const id = await $.session.id()
    const all = ((await $.store.get('boards')) ?? {}) as StoredBoards
    const b = all[id]
    board = b ? { todos: b.todos ?? [], decisions: b.decisions ?? [] } : emptyBoard()
  } catch {
    board = emptyBoard()
  }
}

async function saveBoard($: EngineInterface) {
  try {
    const id = await $.session.id()
    // 다른 대화가 방금 쓴 것을 덮지 않도록 쓰기 직전에 다시 읽어요.
    const all = ((await $.store.get('boards')) ?? {}) as StoredBoards
    all[id] = { at: await $.clock.now(), todos: board.todos, decisions: board.decisions }
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30)
    await $.store.set('boards', Object.fromEntries(keep))
  } catch {
    // 저장이 안 돼도 화면은 그대로 써요.
  }
}

// 입력창 위에 열린 책상을 닫아요. 닫기가 거절되면 다음에 내가 말을 보낼 때 한 번 더 해요.
let inlinePending = false
async function closeInlineDesk($: EngineInterface) {
  try {
    await $.ui.close({ id: PANE })
    inlinePending = false
  } catch (err) {
    inlinePending = true
    $.ui.log(`입력창 위에 열린 책상을 닫지 못했어요: ${String(err)}`)
  }
}

async function registerCommand($: EngineInterface, spec: { name: string; description: string; argumentHint?: string; immediate?: true }) {
  try {
    await $.command.register(spec)
  } catch {
    // 이미 쓰는 이름이면 «desk-» 를 붙여 다시 등록해요. 그래도 안 되면 로그만 남겨요.
    try {
      if (spec.name.startsWith('desk')) throw new Error('이름 겹침')
      await $.command.register({ ...spec, name: `desk-${spec.name}` })
      $.ui.log(`/${spec.name} 은(는) 이미 쓰는 이름이라 /desk-${spec.name} 으로 등록했어요.`)
    } catch (err) {
      $.ui.log(`/${spec.name} 명령을 등록하지 못했어요: ${String(err)}`)
    }
  }
}

// 글로 보여 주는 요약. /desk text 와 점검에 써요.
async function deskText($: EngineInterface): Promise<string> {
  await refreshUsage($)
  updateStatus($)
  const lines: string[] = []
  if (snap) {
    for (const w of snap.windows) lines.push(`${WINDOW_LABEL[w.kind] ?? w.kind}: ${Math.round(w.percentUsed)}% ${untilText(w.resetsAt, snap.updatedAt)}`.trim())
    lines.push(`대화 길이: ${snap.ctxPercent !== undefined ? Math.round(snap.ctxPercent) + '%' : '?'} (${snap.ctxTokens !== undefined ? k(snap.ctxTokens) : '?'} / ${snap.ctxWindow !== undefined ? k(snap.ctxWindow) : '?'})`)
  }
  lines.push(`이어가기: ${MODE_LABEL[mode]} · 프롬프트 가이드: ${coachOn ? '켜짐' : '꺼짐'}`)
  lines.push(`발송 전 확인 ${sendConfirmOn ? '켜짐' : '꺼짐'} · 알림 ${notifyOn ? '켜짐' : '꺼짐'}`)
  for (const g of sendLog.slice(0, 3)) lines.push(`  ${hhmm(g.at)} ${SEND_KIND[g.kind]} ${g.label}`)
  try {
    lines.push(`화면: ${(await $.session.surfaces()).join(', ')}`)
  } catch {
    lines.push('화면: 알 수 없음')
  }
  lines.push(describeBoard(board))
  return lines.join('\n')
}

// ───────────── 이어가기(인수인계) ─────────────

async function writeBrief($: EngineInterface, sessionId: string, tokens: number): Promise<{ path: string; problem?: string }> {
  const messages = await $.session.messages()
  const facts = extractFacts(messages)
  facts.tokens = tokens
  facts.depth = (Number(await $.store.get(`depth:${sessionId}`)) || 0) + 1
  const result = await $.model.complete({
    model: 'haiku',
    system: '당신은 긴 대화를 다음 대화가 바로 이어받을 수 있는 정확한 메모로 정리하는 사람입니다.',
    prompt: briefPrompt(messages, facts, board),
    maxTokens: 4_000,
    timeoutMs: 60_000,
  })
  const text = result.isAnswered ? result.text : ''
  const problem = !result.isAnswered ? result.reason : !text.trim() ? '빈 답' : !isValidBrief(text) ? '소제목이 없음' : undefined
  const cwd = await $.session.cwd()
  const home = await homeDir($)
  const brief = assembleBrief(
    { sessionId, cwd, at: new Date().toISOString(), transcript: `~/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl` },
    facts,
    board,
    problem ? undefined : text,
  )
  const path = `${home}/${BRIEF_DIR}/${sessionId}.md`
  await $.fs.write(path, brief)
  lastBrief = { path, at: await $.clock.now(), tokens, problem }
  return { path, problem }
}

// force=true 면 묻지 않고 바로 넘겨요. 아니면 방식(ask/auto)을 따라요.
async function startHandoff($: EngineInterface, force: boolean) {
  if (inFlight || pending) return
  inFlight = true
  try {
    const sessionId = await $.session.id()
    const usage = await $.session.usage()
    const tokens = usage.context?.tokens ?? 0
    $.ui.toast('이어가기 메모를 쓰는 중이에요…', { timeoutMs: 6000 })
    const { path, problem } = await writeBrief($, sessionId, tokens)
    await $.store.set(`fired:${sessionId}`, 'briefed')
    const mustAsk = !force && mode === 'ask'
    if (mustAsk) {
      let choice = ''
      try {
        choice = await $.ui.ask(
          `대화가 꽤 길어졌어요. 이어서 할 일을 적은 메모는 만들어 뒀어요${problem ? ' (요약이 안 돼서 사실만 담았어요)' : ''}.\n새 대화로 넘길까요?`,
          { header: '이어가기', options: ['새 대화로 넘기기', '이 대화 계속'] },
        )
      } catch {
        return
      }
      if (choice !== '새 대화로 넘기기') {
        $.ui.log(`이어가기 메모만 만들어 뒀어요: ${path}`)
        return
      }
    }
    pending = { oldSession: sessionId, briefPath: path, tokens, board: copyBoard(board), problem }
    await $.store.set('depth:next', (Number(await $.store.get(`depth:${sessionId}`)) || 0) + 1)
    $.command.run({ command: 'clear' }).catch((err: unknown) => {
      pending = undefined
      $.ui.toast(`새 대화로 넘기지 못했어요. 이 대화를 이어 가요. 메모: ${path}`, { timeoutMs: 15000 })
      $.ui.log(`clear 거절: ${String(err)}`)
    })
  } catch (err) {
    pending = undefined
    $.ui.toast(`넘기지 못했어요. 이 대화를 이어 가요. (${String(err).slice(0, 80)})`, { timeoutMs: 15000 })
  } finally {
    inFlight = false
  }
}

// 대화가 기준을 넘었는지 보고, 넘었으면 한 번만 시작해요.
async function maybeHandoff($: EngineInterface) {
  if (mode === 'off' || inFlight || pending) return
  if (!(await isInteractive($))) return
  const usage = await $.session.usage()
  const tokens = usage.context?.tokens
  if (tokens === undefined) return
  const percent = usage.context?.percent
  const over = tokens >= cfg.handoffTokens || (percent !== undefined && percent >= cfg.handoffPercent)
  if (!over) return
  const sessionId = await $.session.id()
  // 이어가기로 막 시작한 대화는 시작 크기(메모·규칙 문서)가 이미 커요. 그 위로 MIN_GROWTH 만큼
  // 자랄 때까지는 묻지 않아요. 안 그러면 새 대화에서 곧바로 또 묻게 돼요.
  if (sessionId === seededSession) {
    if (seedFloor === undefined) {
      seedFloor = tokens
      return
    }
    if (tokens < seedFloor + MIN_GROWTH) return
  }
  if (await $.store.get(`fired:${sessionId}`)) return
  if (mode === 'auto' && unattended >= cfg.maxUnattended) {
    if (pausedSession !== sessionId) {
      pausedSession = sessionId
      $.ui.toast(`자동으로 ${unattended}번 연달아 넘겼어요. 메시지를 보내면 다시 시작해요.`, { timeoutMs: 15000 })
    }
    return
  }
  if (mode === 'auto') unattended++
  // 기다리지 않아요. 메모를 쓰는 동안 화면이 멈추면 안 돼요.
  void startHandoff($, false)
}

// ───────────── 프롬프트 가이드 ─────────────

async function coachReview($: EngineInterface, prompt: string): Promise<Verdict | undefined> {
  const messages = await $.session.messages().catch(() => [])
  const conversation = Array.isArray(messages) ? recentTurns(messages) : ''
  const project = (await $.session.root()).split(/[\\/]/).at(-1) ?? ''
  const stop = new AbortController()
  const timer = $.clock.after(15000, () => stop.abort())
  const result = await $.model.complete(
    {
      model: cfg.coachModel,
      system: COACH_SYSTEM,
      maxTokens: 700,
      prompt: `작업 폴더: ${project}\n최근 대화(오래된 것부터, 비어 있을 수 있음):\n"""${conversation}"""\n\n사용자의 새 요청:\n"""${prompt}"""`,
    },
    { signal: stop.signal },
  )
  timer.cancel()
  const verdict = result.isAnswered ? parseVerdict(result.text) : undefined
  // 원래 글의 낱말을 절반 넘게 버린 고침은 다른 요청이에요. 조용히 둬요.
  if (verdict?.verdict === 'improve' && keptShare(prompt, verdict.rewrite) < 0.5) return { verdict: 'fine' }
  return verdict
}

// ───────────── 화면: 탭 다섯 개 ─────────────

type Els = { Box: any; Text: any; Button: any }

function heading(els: Els, title: string, count?: string) {
  const { Text } = els
  return (
    <Text bold>
      {title} <Text dimColor>{count ?? ''}</Text>
    </Text>
  )
}

function line(els: Els, inner: number, bullet: string, text: string, opts: { dim?: boolean; color?: string } = {}) {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" width={inner}>
      <Text dimColor={opts.dim} color={opts.color}>{'  ' + bullet + ' '}</Text>
      <Box flexShrink={1} flexGrow={1}>
        <Text dimColor={opts.dim} color={opts.color} wrap="wrap">{text}</Text>
      </Box>
    </Box>
  )
}

function pinTab(els: Els, inner: number) {
  const { Box, Text } = els
  const open = board.todos.filter(t => !t.isDone)
  const doneCount = board.todos.length - open.length
  const empty = (text: string) => <Text dimColor>{'  ' + text}</Text>
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '내가 정해야 하는 것', board.decisions.length ? String(board.decisions.length) : '')}
      {board.decisions.length === 0 && empty('없음')}
      {board.decisions.flatMap(d => d.text.split(' / ').map(part => line(els, inner, '?', part)))}
      <Text> </Text>

      {heading(els, '이번 대화 할 일', board.todos.length ? `${doneCount}/${board.todos.length}` : '')}
      {board.todos.length === 0 && empty('없음')}
      {open.map(t => (t.isActive ? line(els, inner, '▸', t.text, { color: 'warning' }) : line(els, inner, '○', t.text)))}
      {doneCount > 0 && <Text dimColor>{`  ✓ ${doneCount}개 끝`}</Text>}
    </Box>
  )
}

function usageTab(els: Els, inner: number) {
  const { Box, Text } = els
  const barWidth = Math.max(8, Math.min(24, inner - 22))
  const stat = (label: string, value: string, color?: string) => (
    <Box flexDirection="row" width={inner}>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor wrap="truncate-end">{'  ' + label}</Text>
      </Box>
      <Text color={color}>{value}</Text>
    </Box>
  )
  if (snap === undefined) {
    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        {heading(els, '사용량')}
        <Text dimColor>{'  아직 못 읽었어요. 한 번 대화를 주고받으면 채워져요.'}</Text>
      </Box>
    )
  }
  const now = snap.updatedAt
  const tone = (pct: number) => (pct >= 95 ? 'error' : pct >= cfg.warnAt ? 'warning' : undefined)
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '사용 한도')}
      {snap.windows.length === 0 && <Text dimColor>{'  한도 정보가 없어요. (한도가 없는 요금제예요)'}</Text>}
      {snap.windows.map(w => {
        const b = burn(w, baseline, now)
        const pct = Math.round(w.percentUsed)
        return (
          <Box flexDirection="column">
            <Text>
              {'  ' + (WINDOW_LABEL[w.kind] ?? w.kind).padEnd(6) + ' '}
              <Text color={tone(w.percentUsed) ?? 'claude'}>{bar(w.percentUsed, barWidth)}</Text>
              <Text color={tone(w.percentUsed)}>{` ${pct}%`}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {'    ' + untilText(w.resetsAt, now) + (b !== null ? ` · 지금 속도면 약 ${hoursText(b.hoursLeft)} 뒤 가득` : '')}
            </Text>
            <Text> </Text>
          </Box>
        )
      })}
      {heading(els, '대화 길이', '가득 차면 앞부분을 잊어요')}
      {snap.ctxPercent !== undefined ? (
        <Text>
          {'  '}
          <Text color={tone(snap.ctxPercent) ?? 'claude'}>{bar(snap.ctxPercent, barWidth)}</Text>
          {` ${Math.round(snap.ctxPercent)}%`}
        </Text>
      ) : (
        <Text dimColor>{'  아직 못 읽었어요.'}</Text>
      )}
      <Text> </Text>
      {heading(els, '이 대화')}
      {stat('비용', snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : '알 수 없음')}
      {stat('경과 시간', `${Math.round((now - snap.startedAt) / 60000)}분`)}
      {stat('주고받은 횟수', String(turnCount))}
    </Box>
  )
}

type HandoffHandlers = { now: () => void; cycle: () => void }

function handoffTab(els: Els, inner: number, act: HandoffHandlers) {
  const { Box, Text, Button } = els
  const barWidth = Math.max(8, Math.min(24, inner - 22))
  const pct = snap?.ctxPercent
  // 토큰 수는 어려운 말이라, 창의 몇 %쯤인지로 풀어서 보여 줘요.
  const triggerPct = snap?.ctxWindow ? Math.min(cfg.handoffPercent, Math.round((cfg.handoffTokens / snap.ctxWindow) * 100)) : cfg.handoffPercent
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '새 대화로 이어가기', '대화가 너무 길어질 때')}
      <Text> </Text>
      <Box flexDirection="row" columnGap={2}>
        <Text>{`  방식  ${MODE_LABEL[mode]}`}</Text>
        <Button key="handoff-mode" label="바꾸기" hotkey="m" plain onPress={act.cycle} />
      </Box>
      <Text dimColor>{`  기준  대화가 ${triggerPct}%쯤 차면`}</Text>
      <Text> </Text>
      <Text>
        {'  지금  '}
        <Text color="claude">{bar(pct ?? 0, barWidth)}</Text>
        {pct !== undefined ? ` ${Math.round(pct)}%` : ' ?'}
      </Text>
      <Text> </Text>
      <Box flexDirection="row" paddingLeft={2}>
        <Button key="handoff-now" label="지금 넘기기" hotkey="n" onPress={act.now} />
      </Box>
      <Text> </Text>
      {heading(els, '마지막 이어가기 메모')}
      {lastBrief === undefined ? (
        <Text dimColor>{'  없음'}</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-middle">{'  ' + lastBrief.path}</Text>
          <Text dimColor>{`  ${hhmm(lastBrief.at)}${lastBrief.problem ? ' · 요약 없이 사실만' : ''}`}</Text>
        </Box>
      )}
      <Text> </Text>
      <Text dimColor>{'  메모는 내 컴퓨터에만 저장돼요'}</Text>
    </Box>
  )
}

type SettingsHandlers = { send: () => void; notify: () => void; coach: () => void }

function settingsTab(els: Els, inner: number, act: SettingsHandlers) {
  const { Box, Text, Button } = els
  const onoff = (v: boolean) => (v ? '켜짐' : '꺼짐')
  const tone: Record<SendEntry['kind'], string | undefined> = { allow: undefined, refuse: 'warning', unattended: 'error' }
  const toggle = (label: string, value: boolean, key: string, hotkey: string, onPress: () => void) => (
    <Box flexDirection="row" columnGap={2}>
      <Text>{`  ${label} ${onoff(value)}`}</Text>
      <Button key={key} label={value ? '끄기' : '켜기'} hotkey={hotkey} onPress={onPress} />
    </Box>
  )
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '설정')}
      {toggle('발송 전 확인', sendConfirmOn, 'toggle-send', 's', act.send)}
      <Text dimColor wrap="wrap">{'    메일·광고·일정·공유처럼 바깥으로 나가는 일은 보내기 전에 내용을 보여 주고 물어요.'}</Text>
      {toggle('알림', notifyOn, 'toggle-notify', 'n', act.notify)}
      <Text dimColor wrap="wrap">{`    ${cfg.notifyMinSeconds}초 넘게 걸린 일이 끝나면 윈도우 알림을 띄워요.`}</Text>
      {toggle('프롬프트 가이드', coachOn, 'toggle-coach', 'c', act.coach)}
      <Text dimColor wrap="wrap">{'    흐릿한 요청이면 고쳐 줘요 · 켜면 작은 모델을 한 번 더 써요'}</Text>
      <Text> </Text>
      {heading(els, '최근 발송 확인', sendLog.length ? String(sendLog.length) : '')}
      {sendLog.length === 0 && <Text dimColor>{'  아직 없어요.'}</Text>}
      {sendLog.slice(0, 8).map(g => line(els, inner, hhmm(g.at), `${SEND_KIND[g.kind]} · ${g.label} · ${g.detail}`, { color: tone[g.kind] }))}
    </Box>
  )
}

type ClipHandlers = { paste: () => void; refresh: () => void; pick: (item: ClipItem) => void }

function clipTab(els: Els, inner: number, act: ClipHandlers) {
  const { Box, Text, Button } = els
  const rows = clipList.slice(0, 10)
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '클립보드', clipAt ? `${hhmm(clipAt)} 기준` : '')}
      {clipNote !== undefined && <Text dimColor wrap="wrap">{'  ' + clipNote}</Text>}
      {rows.length === 0 && clipNote === undefined && <Text dimColor>{clipBusy || clipAt === 0 ? '  읽는 중…' : '  비어 있어요.'}</Text>}
      {rows.map((it, i) => (
        <Box flexDirection="row" width={inner} columnGap={1}>
          <Button key={'clip-item-' + it.id} label={i === 0 ? '▶' : '▷'} plain onPress={() => act.pick(it)} />
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="truncate-end" dimColor={i > 0}>{clipRowText(it)}</Text>
          </Box>
        </Box>
      ))}
      <Text> </Text>
      <Box flexDirection="row" columnGap={2}>
        <Button key="clip-paste" label="최신 것 붙이기" hotkey="p" variant="primary" onPress={act.paste} />
        <Button key="clip-refresh" label="새로 읽기" hotkey="r" onPress={act.refresh} />
      </Box>
      <Text> </Text>
      <Text dimColor>{'  ▶ ▷ 누르면 입력창에 넣어요 · 목록은 Win+V 기록'}</Text>
      <Text dimColor wrap="wrap">{'  복사한 비밀번호도 보일 수 있어요'}</Text>
    </Box>
  )
}

// ───────────── 등록 ─────────────

const SCHEMA = {
  type: 'object',
  properties: {
    add_todos: { type: 'array', items: { type: 'string' } },
    start_todo: { type: 'string' },
    done_todos: { type: 'array', items: { type: 'string' } },
    remove_todos: { type: 'array', items: { type: 'string' } },
    open_decisions: { type: 'array', items: { type: 'string' } },
    decide: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] },
    },
  },
}

const DESCRIPTION = [
  "Keep this session's todo list and open decisions on the user's Pin tab (the side-desk pane), which stays in view while the transcript scrolls.",
  'Use it instead of writing task lists in your reply when the work takes 3+ distinct steps or new instructions arrive.',
  "Any question you end a reply on that needs the user's answer goes in open_decisions, even a single yes/no.",
  'add_todos: one action per item. start_todo: the todo id you are doing now (exactly one at a time). done_todos / remove_todos: todo ids.',
  'Update in real time. Mark a todo done only after the work is really done and verified, never on intent.',
  'If blocked or partly done, leave it in progress and add a todo that names the blocker.',
  'decide: close a decision by id once the user has answered.',
  'The current board, with ids, is at the end of your system prompt.',
].join(' ')

export const register: Register = (on, options) => {
  cfg = parseConfig(options)
  mode = cfg.handoffMode
  coachOn = cfg.coach
  sendConfirmOn = cfg.sendConfirm
  notifyOn = cfg.notify

  on('session.start', async ($, e, next) => {
    const storedMode = await $.store.get('mode')
    if (storedMode === 'ask' || storedMode === 'auto' || storedMode === 'off') mode = storedMode
    const storedCoach = await $.store.get('coach')
    if (typeof storedCoach === 'boolean') coachOn = storedCoach
    const storedSend = await $.store.get('sendConfirm')
    if (typeof storedSend === 'boolean') sendConfirmOn = storedSend
    const storedNotify = await $.store.get('notify')
    if (typeof storedNotify === 'boolean') notifyOn = storedNotify
    await loadBoard($)
    await $.tool.register({ name: 'pin', description: DESCRIPTION, inputSchema: SCHEMA })
    void refreshUsage($).then(() => updateStatus($))
    $.clock.every(60_000, () => void refreshUsage($).then(() => updateStatus($)))
    // 명령어는 이름이 겹치면 던지니까 맨 뒤에서, 하나씩 감싸서 등록해요.
    await registerCommand($, { name: 'desk', description: '책상 열기: 핀·사용·이어가기·클립·설정. text 를 붙이면 글로 보여 줘요', argumentHint: '[text]', immediate: true })
    await registerCommand($, { name: 'coach', description: '프롬프트 가이드 켜기·끄기', argumentHint: '[on|off]' })
    await registerCommand($, { name: 'handoff', description: '대화를 새 대화로 넘겨요', argumentHint: '[now|ask|auto|off]', immediate: true })
    await registerCommand($, { name: 'clip', description: '클립보드의 글을 입력창에 붙여요. 이미지는 파일로 저장하고 경로를 붙여요', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'desk' }, async ($, e) => {
    if (e.args.trim() === 'text') return { text: await deskText($) }
    openedByUser = true // 내가 직접 연 창은 입력창 위에 열려도 닫지 않아요.
    await refreshUsage($)
    updateStatus($)
    // 창을 다시 열었는데 «클립» 탭이 선택돼 있으면 바로 읽어요.
    if (tab === 'clip') void watchClipboard($)
    await $.ui.open({ id: PANE, title: '책상', columns: cfg.paneColumns, focus: true, closeOnEscape: true })
    return {}
  })

  // /clip: 지금 클립보드를 읽어서 입력창에 바로 붙여요. 명령을 친 글이 지워진 뒤에 넣으려고 잠깐 기다려요.
  on('command.run', { command: 'clip' }, async ($) => {
    if (!(await isInteractive($))) return { text: '화면이 있는 세션에서만 쓸 수 있어요.' }
    const c = await readClipboard($)
    if (c.kind === 'empty') return { text: '클립보드가 비어 있어요.' }
    if (c.kind === 'error') return { text: `클립보드를 못 읽었어요: ${c.message}` }
    $.clock.after(150, () => void pasteClip($, c))
    return {}
  })

  on('command.run', { command: 'coach' }, async ($, e) => {
    const arg = e.args.trim()
    coachOn = arg === 'on' ? true : arg === 'off' ? false : !coachOn
    await $.store.set('coach', coachOn)
    $.ui.invalidate('ui.render')
    return { text: `프롬프트 가이드를 ${coachOn ? '켰어요' : '껐어요'}.` }
  })

  // 같은 이름의 /handoff 가 이미 있으면 우리 것은 /desk-handoff 로 등록돼요. 둘 다 같은 일을 해요.
  for (const command of ['handoff', 'desk-handoff']) on('command.run', { command }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'now') {
      if (!(await isInteractive($))) return { text: '화면이 있는 세션에서만 넘길 수 있어요.' }
      void startHandoff($, true)
      return { text: '이어가기 메모를 쓰고 새 대화로 넘길게요.' }
    }
    if (arg === 'ask' || arg === 'auto' || arg === 'off') {
      mode = arg
      await $.store.set('mode', mode)
      $.ui.invalidate('ui.render')
      return { text: `이어가기 방식을 「${MODE_LABEL[mode]}」으로 바꿨어요.` }
    }
    return { text: `이어가기: ${MODE_LABEL[mode]}` + (lastBrief ? `\n마지막 메모: ${lastBrief.path}` : '') }
  })

  // 핀을 Claude 가 고치는 도구
  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { deny: '핀은 메인 대화만 고쳐요.' }
    board = applyUpdate(board, e as Update)
    await saveBoard($)
    updateStatus($)
    $.ui.invalidate('ui.render')
    return { result: describeBoard(board) }
  })

  // Claude가 평소 쓰는 할 일 도구(TodoWrite·TaskCreate·TaskUpdate)를 옆에서 엿봐서 핀에 그대로 옮겨요.
  // 그래서 Claude가 따로 불러 주지 않아도 «이번 대화 할 일»이 채워져요.
  on('tool.call', { tool: [...MIRRORED_TOOLS] }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    try {
      const failed = Boolean((r as { deny?: unknown }).deny || (r as { isError?: unknown }).isError)
      if (!failed) {
        const changed = mirrorTool(board, String(e.tool), e as unknown as Record<string, unknown>, r)
        if (changed) {
          board = changed
          await saveBoard($)
          updateStatus($)
          $.ui.invalidate('ui.render')
        }
      }
    } catch {
      // 핀이 못 따라가도 Claude의 일은 그대로 돼요.
    }
    return r
  })

  // 모든 도구 호출을 한 번 봐요. 바깥으로 나가는 일이면 보내기 전에 물어요.
  // 이 훅이 고장 나도 도구는 그대로 실행돼요(대화가 멈추지 않게).
  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return next(e)
    if (e.tool === 'AskUserQuestion') {
      // Claude가 묻는 질문: 자리를 비웠을 때 알림으로 알려요. (우리 확인창은 이미 알림을 띄웠어요)
      if (!asking) {
        const q = ((e as { questions?: { question?: string }[] }).questions ?? [])[0]?.question
        void osNotify($, 'Claude가 질문해요', q ?? '')
      }
      return next(e)
    }
    const blocked = await sendCheck($, e as unknown as Record<string, unknown>)
    if (blocked) return blocked
    return next(e)
  })

  // 핀은 시스템 프롬프트 끝에 실려서, 답변에 매번 되풀이하지 않아도 돼요.
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    if (board.todos.length + board.decisions.length === 0) return { sections }
    return { sections: [...sections, { id: 'side-desk:board', text: describeBoard(board), scope: 'session' }] }
  })

  // 핀 갱신은 대화창에 흐린 한 줄로만 남겨요. 내용은 옆 창에 있어요.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const change = (e.props.input ?? {}) as Update
    const parts = [
      change.add_todos?.length && `할 일 +${change.add_todos.length}`,
      change.start_todo && `${change.start_todo} 시작`,
      change.done_todos?.length && `${change.done_todos.length}개 끝`,
      change.remove_todos?.length && `할 일 -${change.remove_todos.length}`,
      change.open_decisions?.length && `결정 +${change.open_decisions.length}`,
      change.decide?.length && `결정 ${change.decide.length}개 정함`,
    ].filter(Boolean)
    return <Text dimColor>{'핀: ' + (parts.join(', ') || '바뀐 것 없음')}</Text>
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) =>
    e.props.isErrored ? next(e) : $.ui.resolve(e).Text({ children: [''] }),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const inner = Math.max(10, (e.props.bodyColumns ?? 40) - 2)
    const redraw = () => $.ui.invalidate('ui.render')
    // 옆이 아니라 입력창 위에 열렸다면(클래식 화면) 마우스가 안 눌려요. 클릭은 풀스크린 화면에서만 와요.
    const inline = e.props.placement === 'inline'
    const unfocused = e.props.isFocused === false
    // 풀스크린이 아닌 것이 확실할 때만 닫아요. 시작 직후 너비를 못 쟀거나(모름) 풀스크린인데 잠깐 좁은 때는 그대로 둬요.
    if (inline && e.viewport?.isFullscreen === false && !openedByUser && !inlineClosed) {
      // /desk 로 연 게 아니라 저절로(또는 이전 대화에서) 열린 창이에요. 눌리지도 않는 창이 입력창 위를 차지하지 않게 닫아요.
      inlineClosed = true
      void closeInlineDesk($)
      $.ui.toast('책상을 자동으로 열지 않았어요. 이 화면에서는 눌러서 쓸 수 없어요. /desk 로 열거나 /tui fullscreen 으로 바꿔 보세요.', { timeoutMs: 12000 })
    }
    const notice =
      inline || unfocused ? (
        <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
          {inline && <Text color="warning" wrap="wrap">{'지금은 옆이 아니라 입력창 위에 열렸어요. 이 화면에서는 마우스로 눌러지지 않아요.'}</Text>}
          {inline && <Text dimColor wrap="wrap">{'옆에 붙이고 마우스도 쓰려면 /tui fullscreen 을 한 번 치세요.'}</Text>}
          {unfocused && <Text dimColor>{'키보드: Ctrl+X → Tab'}</Text>}
        </Box>
      ) : null
    const tabBtn = (name: TabName, label: string, hotkey: string) => (
      <Button
        key={'tab-' + name}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={tab !== name}
        onPress={() => {
          tab = name
          redraw()
          // 클립 탭은 열 때 감시를 시작해요.
          if (name === 'clip') void watchClipboard($)
        }}
      />
    )
    const body =
      tab === 'pin'
        ? pinTab(els, inner)
        : tab === 'usage'
          ? usageTab(els, inner)
          : tab === 'clip'
            ? clipTab(els, inner, {
                paste: () => {
                  const newest = clipList[0]
                  if (newest) void pasteItem($, newest)
                },
                refresh: () => void readClipList($).then(redraw),
                pick: (item: ClipItem) => void pasteItem($, item),
              })
            : tab === 'settings'
              ? settingsTab(els, inner, {
                  send: () => {
                    sendConfirmOn = !sendConfirmOn
                    void $.store.set('sendConfirm', sendConfirmOn)
                    redraw()
                  },
                  notify: () => {
                    notifyOn = !notifyOn
                    void $.store.set('notify', notifyOn)
                    redraw()
                  },
                  coach: () => {
                    coachOn = !coachOn
                    void $.store.set('coach', coachOn)
                    redraw()
                  },
                })
              : handoffTab(els, inner, {
                  now: () => void startHandoff($, true),
                  cycle: () => {
                    mode = nextMode(mode)
                    void $.store.set('mode', mode)
                    redraw()
                  },
                })
    return (
      <Box flexDirection="column" width={inner + 2}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={1}>
          {tabBtn('pin', '할 일', '1')}
          {tabBtn('usage', '사용량', '2')}
          {tabBtn('handoff', '이어가기', '3')}
          {tabBtn('clip', '클립보드', '4')}
          {tabBtn('settings', '설정', '5')}
        </Box>
        {notice}
        {body}
      </Box>
    )
  })

  // 한 턴이 끝날 때마다: 사용량 갱신, 한도 경고, 이어가기 기준 확인
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    turnCount++
    // 오래 걸린 일이 끝났을 때 알림. 짧은 턴은 화면을 보고 계시니 조용히 둬요.
    if (!e.isAborted && e.durationMs >= cfg.notifyMinSeconds * 1000) {
      const secs = Math.round(e.durationMs / 1000)
      const took = secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`
      void osNotify($, `작업이 끝났어요 · ${took}`, String(e.answer ?? '').split('\n').find(l => l.trim()) ?? '')
    }
    // 답변이 질문으로 끝나면 «내가 정해야 하는 것»에 올려요. (내가 다음 말을 하면 내려가요)
    try {
      if (!e.isAborted) {
        const q = trailingQuestion(String(e.answer ?? ''))
        const updated = withAutoDecision(board, q)
        if (JSON.stringify(updated.decisions) !== JSON.stringify(board.decisions)) {
          board = updated
          await saveBoard($)
          $.ui.invalidate('ui.render')
        }
      }
    } catch {
      // 위와 같아요.
    }
    try {
      await refreshUsage($)
      updateStatus($)
      if (snap) {
        for (const w of snap.windows) {
          for (const level of [cfg.warnAt, 95]) {
            const id = `${w.kind}:${level}`
            if (w.percentUsed >= level && !warned.has(id)) {
              warned.add(id)
              $.ui.toast(`${WINDOW_LABEL[w.kind] ?? w.kind} 한도가 ${Math.round(w.percentUsed)}%예요 (${untilText(w.resetsAt, snap.updatedAt)})`, { timeoutMs: 10000 })
            }
          }
        }
      }
      await maybeHandoff($)
    } catch {
      // 책상이 실패해도 대화는 그대로 흘러가요.
    }
    return result
  })

  // 보내기 직전: 사람이 쓴 메시지면 연속 이어가기 횟수를 풀고, 프롬프트 가이드가 켜져 있으면 한 번 읽어 봐요.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge'
    if (isPerson) {
      unattended = 0
      pausedSession = undefined
      if (inlinePending && !openedByUser) void closeInlineDesk($)
      // 내가 답했으니 «내가 정해야 하는 것»의 자동 항목을 내려요.
      if (board.decisions.some(d => d.id === 'auto')) {
        board = withAutoDecision(board, undefined)
        void saveBoard($)
        $.ui.invalidate('ui.render')
      }
    }
    if (!coachOn || !isPerson || COACH_SKIP.test(e.text) || e.text.trim().length < 8 || e.text.length > 1500) return next(e)
    if (!(await isInteractive($))) return next(e)

    $.ui.status('도움: 요청을 읽는 중…')
    let verdict: Verdict | undefined
    try {
      verdict = await coachReview($, e.text)
    } catch {
      verdict = undefined
    } finally {
      updateStatus($)
    }
    if (verdict === undefined || verdict.verdict === 'fine') return next(e)

    const SEND_NEW = '고친 문장으로 보내기'
    const SEND_MINE = '내 문장 그대로 보내기'
    const EDIT = '고쳐서 보내기'
    let choice: string
    try {
      choice = await $.ui.ask(`이렇게 쓰면 더 분명해요: ${verdict.why}\n\n${verdict.rewrite}\n\n어느 쪽으로 보낼까요?`, { header: '프롬프트 가이드', options: [SEND_NEW, SEND_MINE, EDIT] })
    } catch {
      return next(e) // 창을 닫으면 내 문장을 그대로 보내요.
    }
    if (choice === SEND_NEW) {
      $.ui.log(`고친 문장으로 보냈어요:\n${verdict.rewrite}`)
      return next({ ...e, text: verdict.rewrite })
    }
    if (choice === SEND_MINE) return next(e)
    if (choice === EDIT) {
      const rewrite = verdict.rewrite
      $.clock.after(150, () => void $.prompt.fill({ text: rewrite }))
      return { drop: '고친 문장을 입력창에 넣었어요. 고친 뒤 엔터를 누르세요.' }
    }
    // 「기타」에 직접 쓴 글이 보내고 싶은 문장이에요.
    $.ui.log(`직접 고친 문장으로 보냈어요:\n${choice}`)
    return next({ ...e, text: choice })
  })

  // 시작하는 순간에는 화면(터미널)이 아직 안 붙어 있을 수 있어요. 그러면 열지 못하고 끝나니, 화면이 붙을 때 한 번 더 시도해요.
  // autoOpenDesk 가 한 번만 열도록 막고 있어서 두 번 열리지는 않아요.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    void autoOpenDesk($)
    return r
  })

  // /clear 뒤: 핀을 새 대화로 옮기고, 이어가기 메모를 읽으라는 첫 메시지를 넣어요.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'resume' || e.source === 'fork') await loadBoard($)
    // 시작·이어하기뿐 아니라 /tui 로 다시 뜬 세션도 있어서, clear·compact 만 빼고 한 번은 열어 봐요.
    if (e.source !== 'compact' && e.source !== 'clear') {
      void autoOpenDesk($)
      // 시작 순간에는 화면이 아직 안 붙어 있고 attach 신호도 안 올 때가 있어요. 몇 초 안에 한 번씩만 다시 봐요(한 번 열면 끝).
      for (const sec of [1, 3, 8, 20]) $.clock.after(sec * 1000, () => void autoOpenDesk($))
    }
    if (e.source !== 'clear') return r
    const p = pending
    pending = undefined
    if (!p) {
      board = emptyBoard()
      updateStatus($)
      return r
    }
    try {
      const newSession = await $.session.id()
      seededSession = newSession
      seedFloor = undefined
      board = p.board
      await saveBoard($)
      await $.store.set(`fired:${p.oldSession}`, `seeded:${newSession}`)
      const depth = await $.store.get('depth:next')
      if (typeof depth === 'number') await $.store.set(`depth:${newSession}`, depth)
      updateStatus($)
      $.ui.toast(`↪ 새 대화로 넘어왔어요${p.problem ? ' (요약 없이 사실만)' : ''}`, { timeoutMs: 10000 })
      $.prompt.submit({ text: seedText(p.oldSession, p.briefPath) }).catch((err: unknown) => {
        $.ui.toast(`첫 메시지가 거절됐어요. 메모 경로를 직접 붙여 주세요: ${p.briefPath}`, { timeoutMs: 20000 })
        $.ui.log(`첫 메시지 거절: ${String(err)}`)
      })
    } catch (err) {
      $.ui.log(`이어가기 시작 실패: ${String(err)}`)
    }
    return r
  })
}
