import type { EngineInterface, Register } from 'claude-code'
import {
  CLIP_LIST_SCRIPT, CLIP_SCRIPT, CLIP_WATCH_SCRIPT, COACH_SKIP, COACH_SYSTEM, WINDOW_LABEL, clipInsertText, clipItemScript, clipRowText, parseClip, parseClipList,
  applyUpdate, assembleBrief, bar, briefPrompt, burn, describeBoard, extractFacts,
  cellWidth, hoursText, isValidBrief, k, keptShare, padCells, parseVerdict, recentTurns, seedText, untilText,
  GMAIL_SERVER, MAIL_PAGE, mailAccount, mailActionPrompt, mailTime, mcpErrorText, mcpJson, parseThread, parseThreadList, safeMailUrl, senderName,
} from './lib.ts'
import type { Board, Clip, ClipItem, Decision, MailRow, MailThread, Todo, Update, UsageWindow, Verdict } from './lib.ts'
import { judgeSend, summarizeArgs } from './send-check.ts'
import { MIRRORED_TOOLS, mirrorTool, trailingQuestion, withAutoDecision } from './mirror.ts'
import {
  CALENDAR_SERVER, CHECK_MARK, EDIT_TOOLS, MIN_VERSION, addChange, calendarArgs, changeLabel, changePrompt, changesFromMessages,
  connectorCheck, editedPath, effectiveGuide, eventEnded, eventTime, guideCommand, guideKey, isDefaultGuide, parseEvents, parseGuideInput,
  permissionNote, versionAtLeast,
} from './extras.ts'
import type { CalEvent, Change, Check, Guide } from './extras.ts'

// side-desk: Claude Code 옆에 «책상» 하나를 열어 줘요.
//  · 할 일   : 이번 대화의 할 일과, 내가 정해야 하는 것을 옆에 고정해 둬요
//  · 사용량  : 사용 한도와 대화 길이, 비용을 한눈에. 대화가 길어지면 이어가기 메모를 쓰고 새 대화로 넘겨요 (인터넷 전송·웹 서버 없음)
//  · 메일    : 연결된 Gmail 받은편지함의 제목 목록, 고르면 본문 (읽기만). 맨 위에 구글 캘린더의 오늘·내일 일정
//  · 고친 파일: 할 일 탭에 이번 대화에서 Claude가 고친 파일 목록, «>»로 왜 바꿨는지 묻기
//  · 클립    : 윈도우 클립보드 기록을 보고 입력창에 바로 붙여요
//  · 설정    : 발송 전 확인 · 알림 · 프롬프트 가이드 · 처음 설정 점검 · 자주 쓰는 명령
//  · 알림    : 긴 작업이 끝났을 때, 질문·승인을 기다릴 때. 윈도우·WSL은 윈도우 알림, 맥·리눅스는 터미널 알림
// 화면이 있는 세션에서만 묻고 움직여요. SIDE_DESK_OFF=1 이면 전부 꺼요.

const PANE = 'side-desk'
const TOOL = 'mcp__side-desk__pin'
const BRIEF_DIR = '.claude/state/side-desk/briefs'

type TabName = 'pin' | 'usage' | 'mail' | 'clip' | 'cmds' | 'settings'
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
  notifyDone: boolean
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
  notifyDone: false,
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
    notifyDone: str(o.notifyDone, 'off').toLowerCase() === 'on',
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
let notifyOn = true // 질문·승인 알림
let notifyDoneOn = false // 작업 끝 알림(기본 꺼짐)
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
// 메일: «메일» 탭을 열 때, «새로고침»을 누를 때, 메일 탭을 보고 있는 동안 5분마다 Gmail 커넥터를 불러요.
//  · 창이 닫혀 있거나 다른 탭을 보고 있으면 부르지 않아요. 따로 저장하지 않고 읽기만 해요.
//  · 목록은 제목만 보여 주고, 줄을 누르면 그 메일의 본문을 불러와요.
let mailState: 'idle' | 'loading' | 'ok' | 'failed' = 'idle'
let mailRows: MailRow[] = []
let mailAt = 0
let mailWho = '' // 연결된 계정 주소(메일 링크의 authuser)
let mailProblem: string | undefined
let mailView: MailThread | undefined // 지금 펼쳐 둔 메일
let mailOpening: string | undefined // 본문을 불러오는 중인 스레드
let mailNote: string | undefined // 본문을 못 불러온 이유
const MAIL_STALE_MS = 2 * 60_000
const MAIL_AUTO_MS = 5 * 60_000
// 일정: 메일과 같은 때(탭을 열 때·새로고침·5분마다) 구글 캘린더 커넥터로 오늘·내일 일정을 읽어요. 읽기만 해요.
let calState: 'idle' | 'loading' | 'ok' | 'failed' = 'idle'
let calEvents: CalEvent[] = []
let calAt = 0
let calProblem: string | undefined
let calLoaded = false // 한 번이라도 읽은 적이 있는지
// 이번 대화에서 고친 파일(Edit·Write·NotebookEdit). 대화마다 따로 저장해요.
let changes: Change[] = []
let rootDir = ''
// 처음 설정 점검: 설정 탭을 처음 열 때 한 번, «다시 점검»을 누를 때 해요.
let checks: Check[] = []
let checking = false
let checked = false // 이 프로세스에서 한 번 점검했는지
let checkAt = 0
// 옆 창이 마지막으로 그려진 모양. 점검의 «화면» 줄이 써요.
let lastPlacement: string | undefined
// 승인 대기 알림이 같은 내용으로 연달아 뜨지 않게
let lastPermNote = { text: '', at: 0 }
// 명령 탭: 내가 넣은 명령과 기본 목록에서 뺀 명령. 다른 대화에서도 그대로예요($.store).
let cmdAdded: Guide[] = []
let cmdHidden: string[] = []
let cmdNote: string | undefined // 넣지 못한 이유
let cmdInputSeq = 0 // 넣을 때마다 올려서 입력 칸을 새로 그려요
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
    if (tab === 'mail') void mailOnTab($)
    if (tab === 'settings') settingsOnTab($)
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

// 알림. 화면이 있는 세션에서, 알림이 켜져 있을 때만 띄워요.
//  · 윈도우·WSL: 윈도우 알림(풍선)
//  · 맥·리눅스: Claude Code 가 터미널로 보내는 알림($.ui.notify). 터미널이 알림을 받아 줘야 떠요.
//  · on: 이 알림을 띄울지. 기본은 «질문·승인 알림» 스위치예요. 작업 끝 알림과 «알림 시험»은 따로 정해서 넘겨요.
async function osNotify($: EngineInterface, title: string, body: string, on: boolean = notifyOn) {
  // 기다리지 않고 부르는 함수라서 어떤 오류도 밖으로 새면 안 돼요. 알림이 안 떠도 일은 그대로 해요.
  try {
    if (!on || !(await isInteractive($))) return
    const exe = await powershellFor($)
    if (!exe) {
      void $.ui.notify(body || title, { title }).catch(() => {})
      return
    }
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

// 고친 파일 목록도 대화마다 따로 두고, 가장 최근 30개 대화만 남겨요.
type StoredChanges = Record<string, { at: number; files: Change[] }>

// 저장해 둔 목록이 없으면(이 기능이 생기기 전에 시작한 대화) 대화 기록에서 한 번 만들어요.
async function loadChanges($: EngineInterface) {
  try {
    const id = await $.session.id()
    const all = ((await $.store.get('changes')) ?? {}) as StoredChanges
    const stored = all[id]?.files
    if (Array.isArray(stored)) {
      changes = stored
      return
    }
    const messages = await $.session.messages().catch(() => [])
    changes = Array.isArray(messages) ? changesFromMessages(messages) : []
  } catch {
    changes = []
  }
}

async function saveChanges($: EngineInterface) {
  try {
    const id = await $.session.id()
    const all = ((await $.store.get('changes')) ?? {}) as StoredChanges
    all[id] = { at: await $.clock.now(), files: changes }
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30)
    await $.store.set('changes', Object.fromEntries(keep))
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
  lines.push(`발송 전 확인 ${sendConfirmOn ? '켜짐' : '꺼짐'} · 질문·승인 알림 ${notifyOn ? '켜짐' : '꺼짐'} · 작업 끝 알림 ${notifyDoneOn ? '켜짐' : '꺼짐'}`)
  for (const g of sendLog.slice(0, 3)) lines.push(`  ${hhmm(g.at)} ${SEND_KIND[g.kind]} ${g.label}`)
  try {
    lines.push(`화면: ${(await $.session.surfaces()).join(', ')}`)
  } catch {
    lines.push('화면: 알 수 없음')
  }
  lines.push(describeBoard(board))
  lines.push(`고친 파일: ${changes.length}개` + (changes.length ? ` (최근: ${changes.slice(0, 3).map(c => changeLabel(c.path, rootDir).name).join(', ')})` : ''))
  lines.push(`명령어 안내: ${effectiveGuide(cmdAdded, cmdHidden).map(guideCommand).join(' ')}`)
  await loadCalendar($)
  const now = await $.clock.now()
  const todayEvents = calEvents.filter(ev => ev.day === 'today').map(ev => `${eventTime(ev, now)} ${ev.title}`)
  lines.push(calState === 'ok' ? `오늘 일정: ${todayEvents.join(' · ') || '없음'} · 내일 ${calEvents.filter(ev => ev.day === 'tomorrow').length}개` : `일정: 못 읽었어요 (${calProblem ?? '이유 모름'})`)
  return lines.join('\n')
}

// ───────────── 메일 (claude.ai Gmail 커넥터, 읽기만) ─────────────

// 받은편지함 최근 메일의 제목을 읽어요. 연결이 안 돼 있거나 로그인이 풀렸으면 이유를 남겨요.
//  · quiet: 저절로 다시 읽을 때예요. 실패해도 오류 화면으로 바꾸지 않고 보던 목록을 그대로 둬요.
async function loadMailList($: EngineInterface, opts: { quiet?: boolean } = {}): Promise<void> {
  if (mailState === 'loading') return
  const quiet = opts.quiet === true && mailState === 'ok'
  mailState = 'loading'
  $.ui.invalidate('ui.render')
  try {
    const r = await $.mcp.call(GMAIL_SERVER, 'search_threads', { query: 'in:inbox', pageSize: MAIL_PAGE, view: 'THREAD_VIEW_MINIMAL' })
    const data = r.isError ? undefined : mcpJson(r)
    if (data === undefined) {
      mailState = quiet ? 'ok' : 'failed'
      if (!quiet) mailProblem = r.isError ? mcpErrorText(r) : 'Gmail 답을 읽지 못했어요'
      return
    }
    mailRows = parseThreadList(data)
    const firstUrl = (data as { threads?: { viewUrl?: unknown }[] }).threads?.[0]?.viewUrl
    mailWho = mailAccount(typeof firstUrl === 'string' ? firstUrl : undefined) || mailWho
    mailState = 'ok'
    mailProblem = undefined
  } catch (err) {
    mailState = quiet ? 'ok' : 'failed'
    if (!quiet) mailProblem = String(err).replace(/\s+/g, ' ').slice(0, 160)
  } finally {
    mailAt = await $.clock.now()
    $.ui.invalidate('ui.render')
  }
}

// 오늘·내일 일정을 읽어요. 캘린더가 연결 안 돼 있어도 메일 목록은 그대로 보여요.
//  · quiet: 저절로 다시 읽을 때예요. 실패해도 보던 일정을 그대로 둬요.
async function loadCalendar($: EngineInterface, opts: { quiet?: boolean } = {}): Promise<void> {
  if (calState === 'loading') return
  const quiet = opts.quiet === true && calState === 'ok'
  calState = 'loading'
  try {
    const now = await $.clock.now()
    const r = await $.mcp.call(CALENDAR_SERVER, 'list_events', calendarArgs(now))
    const data = r.isError ? undefined : mcpJson(r)
    if (data === undefined) {
      calState = quiet ? 'ok' : 'failed'
      if (!quiet) calProblem = r.isError ? mcpErrorText(r) : '캘린더 답을 읽지 못했어요'
      return
    }
    calEvents = parseEvents(data, now)
    calState = 'ok'
    calLoaded = true
    calProblem = undefined
  } catch (err) {
    calState = quiet ? 'ok' : 'failed'
    if (!quiet) calProblem = String(err).replace(/\s+/g, ' ').slice(0, 160)
  } finally {
    calAt = await $.clock.now()
    $.ui.invalidate('ui.render')
  }
}

// 탭을 열 때: 처음이거나, 실패했거나, 2분 넘게 지난 목록이면 다시 읽어요. 일정도 같은 기준이에요.
async function mailOnTab($: EngineInterface) {
  const now = await $.clock.now()
  const stale = (state: string, at: number) => state === 'idle' || state === 'failed' || (state === 'ok' && now - at > MAIL_STALE_MS)
  await Promise.all([stale(mailState, mailAt) ? loadMailList($) : undefined, stale(calState, calAt) ? loadCalendar($) : undefined])
}

// 1분마다 불려요. 옆 창이 보이고 «메일» 탭을 보고 있을 때만, 읽은 지 5분이 지났으면 목록을 다시 읽어요.
//  · 실패한 상태(연결 안 됨·권한 없음)에서는 저절로 다시 부르지 않아요. «다시 시도»를 누르면 돼요.
async function mailTick($: EngineInterface) {
  if (tab !== 'mail') return
  const now = await $.clock.now()
  const mailDue = mailState === 'ok' && now - mailAt >= MAIL_AUTO_MS
  const calDue = calState === 'ok' && now - calAt >= MAIL_AUTO_MS
  if (!mailDue && !calDue) return
  const panes = await $.ui.panes().catch(() => [])
  if (!panes.some(p => p.id === PANE && p.isShown && p.isPlaced)) return
  await Promise.all([mailDue ? loadMailList($, { quiet: true }) : undefined, calDue ? loadCalendar($, { quiet: true }) : undefined])
}

// 줄을 누르면 그 메일(스레드)의 본문을 불러와요. Gmail 의 «읽음» 표시는 바꾸지 않아요.
async function openMail($: EngineInterface, row: MailRow): Promise<void> {
  if (mailOpening) return
  mailOpening = row.id
  mailNote = undefined
  $.ui.invalidate('ui.render')
  try {
    const r = await $.mcp.call(GMAIL_SERVER, 'get_thread', { threadId: row.id, messageFormat: 'PLAIN_TEXT' })
    const t = r.isError ? undefined : parseThread(mcpJson(r))
    if (!t) {
      mailNote = `본문을 못 불러왔어요: ${r.isError ? mcpErrorText(r) : '답을 읽지 못했어요'}`
      return
    }
    mailView = t
    $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
  } catch (err) {
    mailNote = `본문을 못 불러왔어요: ${String(err).replace(/\s+/g, ' ').slice(0, 120)}`
  } finally {
    mailOpening = undefined
    $.ui.invalidate('ui.render')
  }
}

// 연결하기: /mcp 창을 열어요. 거기서 «claude.ai Gmail»을 골라 로그인해요.
function connectGmail($: EngineInterface) {
  $.command.run({ command: 'mcp' }).catch((err: unknown) => {
    $.ui.toast(`/mcp 창을 열지 못했어요. 입력창에 /mcp 를 직접 쳐 주세요. (${String(err).slice(0, 80)})`, { timeoutMs: 10000 })
  })
}

// 펼친 메일을 브라우저의 Gmail 로 열어요. 누를 때만 PowerShell 을 한 번 띄워요.
async function openMailInBrowser($: EngineInterface, url: string | undefined) {
  const safe = safeMailUrl(url)
  const ps = await powershellFor($)
  if (!safe || !ps) {
    $.ui.toast('이 메일은 브라우저로 열 수 없어요.', { timeoutMs: 5000 })
    return
  }
  try {
    await $.process.run([ps, '-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${safe}'`], { timeoutMs: 15000 })
  } catch (err) {
    $.ui.toast(`브라우저를 열지 못했어요: ${String(err).slice(0, 100)}`, { timeoutMs: 6000 })
  }
}

// ───────────── 처음 설정 점검 · 명령어 안내 · 승인 대기 알림 ─────────────

// 명령 탭에서 쓴 글을 목록에 넣어요. 기본 명령을 뺐다가 다시 쓰면 뺀 표시만 풀어요.
//  · 설명을 안 썼으면 Claude Code 가 그 명령에 붙여 둔 한 줄 설명을 가져와요(없으면 빈칸).
async function addGuide($: EngineInterface, text: string) {
  const r = parseGuideInput(text)
  if ('error' in r) {
    cmdNote = r.error
    $.ui.invalidate('ui.render')
    return
  }
  const g: Guide = { ...r.guide }
  const cmd = guideCommand(g)
  if (effectiveGuide(cmdAdded, cmdHidden).some(x => guideCommand(x) === cmd)) {
    cmdNote = `${cmd} 는 이미 목록에 있어요.`
    $.ui.invalidate('ui.render')
    return
  }
  if (isDefaultGuide(g)) {
    cmdHidden = cmdHidden.filter(x => x !== cmd)
  } else {
    if (!g.text) {
      try {
        const found = (await $.command.list()).find(c => c.name === g.name)
        if (found?.description) g.text = found.description.slice(0, 80)
      } catch {
        // 설명이 없어도 넣어요.
      }
    }
    cmdAdded = [...cmdAdded, g].slice(-30)
  }
  cmdNote = undefined
  cmdInputSeq++
  await saveGuide($)
  $.ui.toast(`${cmd} 를 넣었어요.`, { timeoutMs: 4000 })
  $.ui.invalidate('ui.render')
}

async function saveGuide($: EngineInterface) {
  try {
    await $.store.set('cmdAdded', cmdAdded)
    await $.store.set('cmdHidden', cmdHidden)
  } catch {
    // 저장이 안 돼도 이번 대화에서는 보여요.
  }
}


// 커넥터를 가볍게 한 번 불러 봐요. 됐으면 undefined, 아니면 이유.
async function probeConnector($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const r = await $.mcp.call(server, tool, args)
    return r.isError ? mcpErrorText(r) : undefined
  } catch (err) {
    return String(err).replace(/\s+/g, ' ').slice(0, 160)
  }
}

// 새 PC에 깔면 바로 부딪히는 것들을 한 번에 봐요. 설정 탭을 처음 열 때와 «다시 점검»을 누를 때만 해요.
//  · 클립보드 기록 확인은 PowerShell 을 한 번 띄워요(윈도우·WSL만). 주기적으로는 안 해요.
async function runChecks($: EngineInterface): Promise<void> {
  if (checking) return
  checking = true
  $.ui.invalidate('ui.render')
  try {
    const host = await hostKind($)
    const out: Check[] = []

    const ver = await $.session.version().catch(() => undefined)
    const verOk = ver ? versionAtLeast(ver.base ?? ver.version, MIN_VERSION) : undefined
    out.push(
      verOk === false
        ? { id: 'version', label: 'Claude Code 버전', state: 'bad', detail: `${ver!.version} · ${MIN_VERSION} 이상이 필요해요`, fix: '터미널에서 claude update' }
        : { id: 'version', label: 'Claude Code 버전', state: verOk ? 'ok' : 'na', detail: ver ? ver.version : '확인하지 못했어요' },
    )

    out.push(
      lastPlacement === undefined
        ? { id: 'screen', label: '화면', state: 'na', detail: '책상을 열면 확인해요' }
        : lastPlacement === 'inline'
          ? { id: 'screen', label: '화면', state: 'bad', detail: '책상이 입력창 위에 열려서 마우스로 안 눌려요', fix: '/tui fullscreen 을 한 번 치기' }
          : { id: 'screen', label: '화면', state: 'ok', detail: '옆 창 · 마우스로 눌러요' },
    )

    const [gmail, cal] = await Promise.all([
      probeConnector($, GMAIL_SERVER, 'search_threads', { query: 'in:inbox', pageSize: 1, view: 'THREAD_VIEW_MINIMAL' }),
      probeConnector($, CALENDAR_SERVER, 'list_events', { ...calendarArgs(await $.clock.now()), pageSize: 1 }),
    ])
    out.push(connectorCheck('gmail', 'Gmail (메일 탭)', GMAIL_SERVER, ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread'], gmail))
    out.push(connectorCheck('calendar', '구글 캘린더 (일정)', CALENDAR_SERVER, ['mcp__claude_ai_Google_Calendar__list_events'], cal))

    const ps = await powershellFor($)
    if (!ps) {
      out.push({ id: 'clip', label: '클립보드 기록', state: 'na', detail: '윈도우에서만 써요' })
      out.push({ id: 'notify', label: '알림', state: 'ok', detail: '터미널 알림을 써요. 안 뜨면 터미널의 알림 설정을 보세요' })
    } else {
      let psProblem: string | undefined
      if (host === 'wsl' && ps === 'powershell.exe') psProblem = 'WSL에서 윈도우 PowerShell 을 못 찾았어요'
      let clipProblem: string | undefined
      if (!psProblem) {
        try {
          const run = await $.process.run([ps, '-NoProfile', '-STA', '-Command', CLIP_LIST_SCRIPT], { timeoutMs: 15000 })
          clipProblem = run.exitCode === 0 ? parseClipList(run.stdout).problem : (run.stderr || `종료 코드 ${run.exitCode}`).trim().slice(0, 120)
        } catch (err) {
          psProblem = `PowerShell 을 실행하지 못했어요: ${String(err).slice(0, 100)}`
        }
      }
      out.push(
        psProblem
          ? { id: 'clip', label: '클립보드 기록', state: 'bad', detail: psProblem, fix: '클립보드 탭과 알림이 안 돼요. /mnt/c 가 보이는지 확인' }
          : clipProblem
            ? { id: 'clip', label: '클립보드 기록', state: 'bad', detail: '윈도우 클립보드 기록이 꺼져 있어요', fix: '윈도우 설정 > 시스템 > 클립보드 > 클립보드 기록 켜기' }
            : { id: 'clip', label: '클립보드 기록', state: 'ok', detail: '켜져 있어요' },
      )
      out.push(psProblem ? { id: 'notify', label: '알림', state: 'bad', detail: psProblem } : { id: 'notify', label: '알림', state: 'ok', detail: '윈도우 알림을 써요' })
    }
    if (!notifyOn && !notifyDoneOn) {
      const i = out.findIndex(c => c.id === 'notify')
      if (i >= 0) out[i] = { id: 'notify', label: '알림', state: 'na', detail: '두 알림 다 꺼 뒀어요 (위 스위치)' }
    }

    checks = out
    checked = true
  } catch (err) {
    checks = [{ id: 'error', label: '점검', state: 'bad', detail: `점검하다 멈췄어요: ${String(err).slice(0, 120)}` }]
  } finally {
    checking = false
    checkAt = await $.clock.now()
    $.ui.invalidate('ui.render')
  }
}

// 설정 탭을 열 때: 점검은 처음 한 번만 해요.
function settingsOnTab($: EngineInterface) {
  if (!checked && !checking) void runChecks($)
}

// Claude Code 가 «이 도구를 써도 될까요?» 창을 띄우면 알려요. 같은 내용이 10초 안에 또 오면 한 번만 알려요.
async function notifyPermission($: EngineInterface, tool: string, input: unknown) {
  try {
    const note = permissionNote(tool, input)
    if (!note) return
    const now = await $.clock.now()
    const text = note.title + note.body
    if (text === lastPermNote.text && now - lastPermNote.at < 10_000) return
    lastPermNote = { text, at: now }
    await osNotify($, note.title, note.body)
  } catch {
    // 알림이 안 떠도 승인 창은 그대로 떠요.
  }
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

type Els = { Box: any; Text: any; Button: any; Input?: any }

// 소제목: 굵게 + 밑줄로 본문과 구분하고, 아래에 한 줄을 띄워요. 옆의 작은 글(개수·기준)은 흐리게, 밑줄 없이.
// 색은 쓰지 않아요(경고 색과 섞이면 지저분해져요).
function heading(els: Els, title: string, count?: string) {
  const { Box, Text } = els
  return (
    <Box paddingBottom={1} flexShrink={1}>
      <Text wrap="truncate-end">
        <Text bold underline>{title}</Text>
        <Text dimColor>{count ? ' ' + count : ''}</Text>
      </Text>
    </Box>
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

// 여러 줄로 넘어가는 설명. 들여쓰기를 빈칸 글자가 아니라 여백으로 줘서, 넘어간 줄도 같은 자리에서 시작해요.
// (빈칸 글자로 들여 쓰면 둘째 줄부터 맨 왼쪽으로 붙어요)
function para(els: Els, inner: number, text: string, opts: { indent?: number; dim?: boolean; color?: string } = {}) {
  const { Box, Text } = els
  return (
    <Box paddingLeft={opts.indent ?? 2} width={inner}>
      <Text dimColor={opts.dim} color={opts.color} wrap="wrap">{text}</Text>
    </Box>
  )
}

type PinHandlers = { explain: (path: string) => void }

const CHANGES_SHOWN = 6

// 이번 대화에서 고친 파일. 최근에 고친 것이 위. «>»를 누르면 왜 바꿨는지 묻는 글을 입력창에 넣어요.
function changesBlock(els: Els, inner: number, act: PinHandlers) {
  const { Box, Text, Button } = els
  const rows = changes.slice(0, CHANGES_SHOWN)
  return (
    <Box flexDirection="column">
      {heading(els, '이번 대화에서 고친 파일', changes.length ? String(changes.length) : '')}
      {changes.length === 0 && <Text dimColor>{'  없음'}</Text>}
      {rows.map((c, i) => {
        const { name, dir } = changeLabel(c.path, rootDir)
        return (
          <Box flexDirection="row" width={inner} columnGap={1}>
            <Button key={'chg-' + i} label=">" plain onPress={() => act.explain(c.path)} />
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-end">
                {name}
                <Text dimColor>{(c.count > 1 ? ` ×${c.count}` : '') + (dir ? '  ' + dir : '')}</Text>
              </Text>
            </Box>
          </Box>
        )
      })}
      {changes.length > CHANGES_SHOWN && <Text dimColor>{`    … 외 ${changes.length - CHANGES_SHOWN}개`}</Text>}
      {changes.length > 0 && para(els, inner, '> 누르면 왜 바꿨는지 물어요 · Edit·Write로 고친 것만', { dim: true })}
    </Box>
  )
}

function pinTab(els: Els, inner: number, act: PinHandlers) {
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
      <Text> </Text>

      {changesBlock(els, inner, act)}
    </Box>
  )
}

type HandoffHandlers = { now: () => void; cycle: () => void }

// 새 대화로 이어가기. 사용량 탭의 «대화 길이» 막대 바로 아래에 붙어요(같은 막대를 두 번 그리지 않으려고 탭을 합쳤어요).
function handoffBlock(els: Els, act: HandoffHandlers) {
  const { Box, Text, Button } = els
  // 토큰 수는 어려운 말이라, 창의 몇 %쯤인지로 풀어서 보여 줘요.
  const triggerPct = snap?.ctxWindow ? Math.min(cfg.handoffPercent, Math.round((cfg.handoffTokens / snap.ctxWindow) * 100)) : cfg.handoffPercent
  return (
    <Box flexDirection="column">
      <Text> </Text>
      {heading(els, '새 대화로 이어가기')}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text>{`  방식  ${MODE_LABEL[mode]}`}</Text>
        <Button key="handoff-mode" label="바꾸기" hotkey="m" plain onPress={act.cycle} />
      </Box>
      <Text dimColor wrap="truncate-end">{`  기준  대화가 ${triggerPct}%쯤 차면`}</Text>
      <Box flexDirection="row" paddingLeft={2} paddingTop={1}>
        <Button key="handoff-now" label="지금 넘기기" hotkey="n" onPress={act.now} />
      </Box>
      {lastBrief !== undefined && (
        <Box flexDirection="column" paddingTop={1}>
          <Text dimColor wrap="truncate-middle">{'  마지막 메모 ' + lastBrief.path}</Text>
          <Text dimColor>{`  ${hhmm(lastBrief.at)}${lastBrief.problem ? ' · 요약 없이 사실만' : ''}`}</Text>
        </Box>
      )}
      <Text dimColor>{'  메모는 내 컴퓨터에만 저장돼요'}</Text>
    </Box>
  )
}

function usageTab(els: Els, inner: number, act: HandoffHandlers) {
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
        {para(els, inner, '아직 못 읽었어요. 한 번 대화를 주고받으면 채워져요.', { dim: true })}
        {handoffBlock(els, act)}
      </Box>
    )
  }
  const now = snap.updatedAt
  const tone = (pct: number) => (pct >= 95 ? 'error' : pct >= cfg.warnAt ? 'warning' : undefined)
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '사용 한도')}
      {snap.windows.length === 0 && para(els, inner, '한도 정보가 없어요. (한도가 없는 요금제예요)', { dim: true })}
      {snap.windows.map(w => {
        const b = burn(w, baseline, now)
        const pct = Math.round(w.percentUsed)
        return (
          <Box flexDirection="column">
            <Text>
              {'  ' + padCells(WINDOW_LABEL[w.kind] ?? w.kind, 6) + ' '}
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
      {handoffBlock(els, act)}
      <Text> </Text>
      {heading(els, '이 대화')}
      {stat('비용', snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : '알 수 없음')}
      {stat('경과 시간', `${Math.round((now - snap.startedAt) / 60000)}분`)}
      {stat('주고받은 횟수', String(turnCount))}
    </Box>
  )
}

// 메일 탭 맨 위의 오늘·내일 일정. 읽기만 해요. 캘린더가 안 붙어 있으면 한 줄로 알려 주고, 메일은 그대로 보여요.
function calendarBlock(els: Els, inner: number, now: number) {
  const { Box, Text } = els
  const today = calEvents.filter(ev => ev.day === 'today')
  const tomorrow = calEvents.filter(ev => ev.day === 'tomorrow')
  const row = (ev: CalEvent) => {
    const ended = eventEnded(ev, now)
    return (
      <Box flexDirection="row" width={inner} columnGap={1} paddingLeft={2}>
        <Box flexShrink={0}>
          <Text dimColor={ended} color={ended ? undefined : 'claude'}>{padCells(eventTime(ev, now), 6)}</Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor={ended} wrap="truncate-end">
            {ev.title}
            <Text dimColor>{ev.location ? '  ' + ev.location : ''}</Text>
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingBottom={1}>
      {heading(els, '일정', '오늘·내일')}
      {calState === 'failed' &&
        para(els, inner, /permission|권한|haven't granted/i.test(calProblem ?? '') ? '캘린더를 읽는 권한을 아직 안 받았어요. 설정 탭 «점검»에서 고치는 법을 보세요.' : '캘린더를 못 읽었어요. 설정 탭 «점검»에서 연결을 확인하세요.', { dim: true })}
      {(calState === 'idle' || (calState === 'loading' && !calLoaded)) && <Text dimColor>{'  불러오는 중…'}</Text>}
      {calState !== 'failed' && calLoaded && (
        <Box flexDirection="column">
          {today.length === 0 ? <Text dimColor>{'  오늘 일정 없음'}</Text> : today.map(row)}
          {tomorrow.length > 0 && <Text dimColor>{'  내일'}</Text>}
          {tomorrow.map(row)}
        </Box>
      )}
    </Box>
  )
}

// ask = «>» 조치사항 찾기 프롬프트를 입력창에 넣기 · browser = Gmail 에서 열기
type MailHandlers = { open: (row: MailRow) => void; back: () => void; refresh: () => void; connect: () => void; ask: (m: { id: string; subject: string; from: string; date: string }) => void; browser: (url: string | undefined) => void }

function mailTab(els: Els, inner: number, now: number, act: MailHandlers) {
  const { Box, Text, Button } = els
  // 펼친 메일: 최신 메일이 위, 본문은 옆 창에서 스크롤해서 봐요.
  if (mailView !== undefined) {
    const v = mailView
    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="mail-back" label="← 목록" hotkey="b" plain onPress={act.back} />
          <Button
            key="mail-ask"
            label="> 조치사항"
            hotkey="i"
            plain
            onPress={() => act.ask({ id: v.id, subject: v.subject, from: v.messages[0]?.from ?? '', date: v.messages[0]?.date ?? '' })}
          />
          {safeMailUrl(v.url) !== undefined && <Button key="mail-browser" label="↗ Gmail" hotkey="o" plain dimColor onPress={() => act.browser(v.url)} />}
        </Box>
        <Text> </Text>
        <Text bold wrap="wrap">{v.subject}</Text>
        {v.total > 1 && <Text dimColor wrap="truncate-end">{`${v.total}통 · 최신부터` + (v.total > v.messages.length ? ` · 앞의 ${v.total - v.messages.length}통은 Gmail에서` : '')}</Text>}
        {v.messages.map((m, i) => (
          <Box flexDirection="column" paddingTop={1}>
            <Text color={i === 0 ? 'claude' : undefined} dimColor={i > 0} wrap="truncate-end">{`${senderName(m.from)} · ${mailTime(m.date, now)}`}</Text>
            <Text wrap="wrap" dimColor={i > 0}>{m.body || '(본문 없음)'}</Text>
            {m.cut && <Text dimColor>{'… 길어서 잘랐어요. 나머지는 Gmail에서 보세요.'}</Text>}
          </Box>
        ))}
      </Box>
    )
  }

  const head = heading(els, '메일')
  const cal = calendarBlock(els, inner, now)
  // 연결은 돼 있는데 도구 권한을 안 받은 경우(권한 묻기를 건너뛰지 않는 세션). 이때는 다시 연결해도 소용없어요.
  if (mailState === 'failed' && /permission|권한/i.test(mailProblem ?? '')) {
    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        {cal}
        {head}
        {para(els, inner, 'Gmail은 연결돼 있는데, 메일을 읽는 권한을 아직 안 받았어요.', { color: 'warning' })}
        {para(els, inner, '/permissions 에서 mcp__claude_ai_Gmail__search_threads 와 mcp__claude_ai_Gmail__get_thread 를 허용한 뒤 «다시 시도»를 누르세요.', { dim: true })}
        <Box flexDirection="row" paddingLeft={2} paddingTop={1}>
          <Button key="mail-refresh" label="다시 시도" hotkey="r" onPress={act.refresh} />
        </Box>
      </Box>
    )
  }
  if (mailState === 'failed') {
    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        {cal}
        {head}
        {para(els, inner, 'Gmail을 불러오지 못했어요. 연결이 안 돼 있거나 로그인이 풀렸을 수 있어요.', { color: 'warning' })}
        {mailProblem !== undefined && para(els, inner, mailProblem, { dim: true })}
        <Box flexDirection="row" columnGap={2} paddingLeft={2} paddingTop={1}>
          <Button key="mail-connect" label="연결하기" hotkey="c" variant="primary" onPress={act.connect} />
          <Button key="mail-refresh" label="다시 시도" hotkey="r" onPress={act.refresh} />
        </Box>
        <Text> </Text>
        {para(els, inner, '연결하기를 누르면 /mcp 창이 열려요. «claude.ai Gmail»을 골라 로그인한 뒤 «다시 시도»를 누르세요.', { dim: true })}
        {para(els, inner, '목록에 Gmail이 없으면 claude.ai 설정 > 커넥터에서 먼저 추가하세요.', { dim: true })}
      </Box>
    )
  }

  const timeWidth = 5
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {cal}
      <Box flexDirection="row" justifyContent="space-between" width={inner}>
        {head}
        <Button key="mail-refresh" label="새로고침" hotkey="r" plain dimColor onPress={act.refresh} />
      </Box>
      {mailWho !== '' && <Text dimColor wrap="truncate-end">{'  ' + mailWho}</Text>}
      {mailState === 'loading' && mailRows.length === 0 && <Text dimColor>{'  불러오는 중…'}</Text>}
      {mailState === 'idle' && <Text dimColor>{'  잠깐만요…'}</Text>}
      {mailState === 'ok' && mailRows.length === 0 && <Text dimColor>{'  받은편지함이 비어 있어요.'}</Text>}
      {mailOpening !== undefined && <Text color="claude">{'  본문을 불러오는 중…'}</Text>}
      {mailNote !== undefined && para(els, inner, mailNote, { color: 'warning' })}
      {mailRows.map(r => (
        <Box flexDirection="row" width={inner} columnGap={1}>
          <Button key={'mail-' + r.id} label={r.unread ? '●' : '○'} plain dimColor={!r.unread} onPress={() => act.open(r)} />
          <Box flexShrink={1} flexGrow={1}>
            <Text bold={r.unread} dimColor={!r.unread} wrap="truncate-end">{r.subject + (r.count > 1 ? ` (${r.count})` : '')}</Text>
          </Box>
          <Box flexDirection="row" flexShrink={0} columnGap={1}>
            <Text dimColor>{mailTime(r.date, now).padStart(timeWidth)}</Text>
            <Button key={'mail-ask-' + r.id} label=">" plain onPress={() => act.ask(r)} />
            {safeMailUrl(r.url) !== undefined ? (
              <Button key={'mail-web-' + r.id} label="↗" plain dimColor onPress={() => act.browser(r.url)} />
            ) : (
              <Text> </Text>
            )}
          </Box>
        </Box>
      ))}
      <Text> </Text>
      {para(els, inner, '●○ 본문 · > 조치사항 · ↗ Gmail', { dim: true })}
      {para(els, inner, (mailAt ? `${hhmm(mailAt)} 기준 · ` : '') + '읽기만 해요', { dim: true })}
    </Box>
  )
}

type SettingsHandlers = {
  send: () => void
  notify: () => void
  notifyDone: () => void
  coach: () => void
  recheck: () => void
  testNotify: () => void
}

// 처음 설정 점검: ✓ 됨 · ✗ 고칠 것(아래에 고치는 법) · – 이 환경엔 해당 없음
function checksBlock(els: Els, inner: number, act: SettingsHandlers) {
  const { Box, Text, Button } = els
  const tone: Record<Check['state'], string | undefined> = { ok: 'success', bad: 'error', na: undefined, wait: undefined }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" width={inner}>
        {heading(els, '점검', checked ? `${hhmm(checkAt)} 기준` : '')}
        <Button key="recheck" label={checking ? '점검 중…' : '다시 점검'} hotkey="k" plain dimColor onPress={act.recheck} />
      </Box>
      {checks.length === 0 && <Text dimColor>{checking ? '  점검하는 중…' : '  아직 안 했어요'}</Text>}
      {checks.map(c => (
        <Box flexDirection="column">
          {line(els, inner, CHECK_MARK[c.state], `${c.label} · ${c.detail}`, { color: tone[c.state], dim: c.state === 'na' })}
          {c.fix !== undefined && para(els, inner, '→ ' + c.fix, { indent: 6, dim: true })}
        </Box>
      ))}
      <Box flexDirection="row" paddingLeft={2} paddingTop={1}>
        <Button key="notify-test" label="알림 시험" hotkey="t" onPress={act.testNotify} />
      </Box>
    </Box>
  )
}

type CmdHandlers = { run: (g: Guide) => void; remove: (g: Guide) => void; add: (text: string) => void; reset: () => void }

// 자주 쓰는 명령 탭. 누르면 입력창에 넣기만 하고 실행은 엔터로 해요(/clear 처럼 되돌릴 수 없는 것도 있어서요).
//  · × 로 목록에서 빼고, 아래 칸에 «/명령 설명»을 쓰고 엔터로 넣어요. 다른 대화에서도 그대로예요.
function commandsTab(els: Els, inner: number, act: CmdHandlers) {
  const { Box, Text, Button, Input } = els
  const list = effectiveGuide(cmdAdded, cmdHidden)
  const changed = cmdAdded.length > 0 || cmdHidden.length > 0
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '자주 쓰는 명령', '누르면 입력창에')}
      {list.length === 0 && <Text dimColor>{'  없음'}</Text>}
      {list.map(g => (
        <Box flexDirection="row" width={inner} columnGap={1} paddingLeft={2}>
          <Box flexShrink={0}>
            <Button key={guideKey(g)} label={guideCommand(g)} plain onPress={() => act.run(g)} />
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text dimColor wrap="wrap">{g.text || ' '}</Text>
          </Box>
          <Box flexShrink={0}>
            <Button key={'del-' + guideKey(g)} label="×" plain dimColor onPress={() => act.remove(g)} />
          </Box>
        </Box>
      ))}
      <Text> </Text>
      {heading(els, '명령 넣기')}
      {Input ? (
        <Box paddingLeft={2} width={inner}>
          {/* 넣고 나면 key 를 바꿔서 빈 칸을 새로 그려요(값을 억지로 비우면 다시 그릴 때마다 쓰던 글이 지워져요) */}
          <Input key={'cmd-add-' + cmdInputSeq} placeholder="/명령 설명" submitLabel="넣기" onSubmit={(v: string) => act.add(v)} />
        </Box>
      ) : (
        para(els, inner, '이 화면에서는 입력 칸을 못 그려요. 터미널이나 데스크톱 앱에서 넣어 주세요.', { dim: true })
      )}
      {cmdNote !== undefined && para(els, inner, cmdNote, { color: 'warning' })}
      {para(els, inner, '예: /capcut 릴스 편집 · 인자가 있으면 /tui fullscreen - 설명', { dim: true })}
      {para(els, inner, '× 누르면 목록에서 빼요', { dim: true })}
      {changed && (
        <Box flexDirection="row" paddingLeft={2} paddingTop={1}>
          <Button key="cmd-reset" label="처음 목록으로" onPress={act.reset} />
        </Box>
      )}
    </Box>
  )
}

function settingsTab(els: Els, inner: number, act: SettingsHandlers) {
  const { Box, Text, Button } = els
  const onoff = (v: boolean) => (v ? '켜짐' : '꺼짐')
  const tone: Record<SendEntry['kind'], string | undefined> = { allow: undefined, refuse: 'warning', unattended: 'error' }
  const toggle = (label: string, value: boolean, key: string, hotkey: string, onPress: () => void) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text>{`  ${label} ${onoff(value)}`}</Text>
      <Button key={key} label={value ? '끄기' : '켜기'} hotkey={hotkey} onPress={onPress} />
    </Box>
  )
  return (
    <Box flexDirection="column" width={inner + 2} padding={1}>
      {heading(els, '설정')}
      {toggle('발송 전 확인', sendConfirmOn, 'toggle-send', 's', act.send)}
      {para(els, inner, '메일·광고·일정·공유처럼 바깥으로 나가는 일은 보내기 전에 내용을 보여 주고 물어요.', { indent: 4, dim: true })}
      <Text> </Text>
      {toggle('질문·승인 알림', notifyOn, 'toggle-notify', 'n', act.notify)}
      {para(els, inner, 'Claude가 질문하거나 승인을 기다리면 알려요.', { indent: 4, dim: true })}
      <Text> </Text>
      {toggle('작업 끝 알림', notifyDoneOn, 'toggle-notify-done', 'd', act.notifyDone)}
      {para(els, inner, `${cfg.notifyMinSeconds}초 넘게 걸린 일이 끝나면 알려요.`, { indent: 4, dim: true })}
      <Text> </Text>
      {toggle('프롬프트 가이드', coachOn, 'toggle-coach', 'c', act.coach)}
      {para(els, inner, '흐릿한 요청이면 고쳐 줘요 · 켜면 작은 모델을 한 번 더 써요', { indent: 4, dim: true })}
      <Text> </Text>

      {checksBlock(els, inner, act)}
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
      {clipNote !== undefined && para(els, inner, clipNote, { dim: true })}
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
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="clip-paste" label="최신 것 붙이기" hotkey="p" variant="primary" onPress={act.paste} />
        <Button key="clip-refresh" label="새로 읽기" hotkey="r" onPress={act.refresh} />
      </Box>
      <Text> </Text>
      {para(els, inner, '▶ ▷ 누르면 입력창에 넣어요 · 목록은 Win+V 기록', { dim: true })}
      {para(els, inner, '복사한 비밀번호도 보일 수 있어요', { dim: true })}
    </Box>
  )
}

// 탭 이름은 넓을 때·보통·좁을 때 세 벌. 탭 줄이 한 줄에 들어가는 가장 긴 벌을 골라요.
const TABS: { name: TabName; hotkey: string; labels: [string, string, string] }[] = [
  { name: 'pin', hotkey: '1', labels: ['할 일', '할 일', '할일'] },
  { name: 'usage', hotkey: '2', labels: ['사용량', '사용량', '한도'] },
  { name: 'mail', hotkey: '3', labels: ['메일·일정', '메일', '메일'] },
  { name: 'clip', hotkey: '4', labels: ['클립보드', '클립', '클립'] },
  { name: 'cmds', hotkey: '5', labels: ['명령', '명령', '명령'] },
  { name: 'settings', hotkey: '6', labels: ['설정', '설정', '설정'] },
]

// 단추 하나는 «1: 이름»(3칸 + 이름)이고 단추 사이는 한 칸이에요. room = 탭 줄에 쓸 수 있는 칸 수.
export function tabLabelSet(room: number): 0 | 1 | 2 {
  for (const i of [0, 1] as const) {
    const w = TABS.reduce((sum, t) => sum + 3 + cellWidth(t.labels[i]), 0) + (TABS.length - 1)
    if (w <= room) return i
  }
  return 2
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
  notifyDoneOn = cfg.notifyDone

  on('session.start', async ($, e, next) => {
    const storedMode = await $.store.get('mode')
    if (storedMode === 'ask' || storedMode === 'auto' || storedMode === 'off') mode = storedMode
    const storedCoach = await $.store.get('coach')
    if (typeof storedCoach === 'boolean') coachOn = storedCoach
    const storedSend = await $.store.get('sendConfirm')
    if (typeof storedSend === 'boolean') sendConfirmOn = storedSend
    const storedNotify = await $.store.get('notify')
    if (typeof storedNotify === 'boolean') notifyOn = storedNotify
    const storedDone = await $.store.get('notifyDone')
    if (typeof storedDone === 'boolean') notifyDoneOn = storedDone
    const storedAdded = (await $.store.get('cmdAdded')) as unknown
    if (Array.isArray(storedAdded)) cmdAdded = storedAdded.filter((g): g is Guide => !!g && typeof (g as Guide).name === 'string' && typeof (g as Guide).text === 'string')
    const storedHidden = (await $.store.get('cmdHidden')) as unknown
    if (Array.isArray(storedHidden)) cmdHidden = storedHidden.filter((x): x is string => typeof x === 'string')
    await loadBoard($)
    rootDir = await $.session.root().catch(() => '')
    await loadChanges($)
    await $.tool.register({ name: 'pin', description: DESCRIPTION, inputSchema: SCHEMA })
    void refreshUsage($).then(() => updateStatus($))
    $.clock.every(60_000, () => {
      void refreshUsage($).then(() => updateStatus($))
      void mailTick($)
    })
    // 명령어는 이름이 겹치면 던지니까 맨 뒤에서, 하나씩 감싸서 등록해요.
    await registerCommand($, { name: 'desk', description: '책상 열기: 할 일·사용량(이어가기 포함)·메일·일정·클립·명령·설정. text 는 글로 보기, check 는 처음 설정 점검', argumentHint: '[text|check]', immediate: true })
    await registerCommand($, { name: 'coach', description: '프롬프트 가이드 켜기·끄기', argumentHint: '[on|off]' })
    await registerCommand($, { name: 'handoff', description: '대화를 새 대화로 넘겨요', argumentHint: '[now|ask|auto|off]', immediate: true })
    await registerCommand($, { name: 'clip', description: '클립보드의 글을 입력창에 붙여요. 이미지는 파일로 저장하고 경로를 붙여요', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'desk' }, async ($, e) => {
    if (e.args.trim() === 'text') return { text: await deskText($) }
    if (e.args.trim() === 'check') {
      await runChecks($)
      return { text: ['처음 설정 점검', ...checks.flatMap(c => [`${CHECK_MARK[c.state]} ${c.label} · ${c.detail}`, ...(c.fix ? [`    → ${c.fix}`] : [])])].join('\n') }
    }
    openedByUser = true // 내가 직접 연 창은 입력창 위에 열려도 닫지 않아요.
    await refreshUsage($)
    updateStatus($)
    // 창을 다시 열었는데 «클립» 탭이 선택돼 있으면 바로 읽어요. «메일» 탭이면 받은편지함 제목을 읽어요.
    if (tab === 'clip') void watchClipboard($)
    if (tab === 'mail') void mailOnTab($)
    if (tab === 'settings') settingsOnTab($)
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

  // 파일을 고친 도구(Edit·Write·NotebookEdit)가 성공하면 «이번 대화에서 고친 파일»에 올려요. 서브에이전트가 고친 것도 올려요.
  on('tool.call', { tool: [...EDIT_TOOLS] }, async ($, e, next) => {
    const r = await next(e)
    try {
      const failed = Boolean((r as { deny?: unknown }).deny || (r as { isError?: unknown }).isError)
      const path = editedPath(e)
      if (!failed && path) {
        changes = addChange(changes, path, await $.clock.now())
        await saveChanges($)
        $.ui.invalidate('ui.render')
      }
    } catch {
      // 목록이 못 따라가도 Claude의 일은 그대로 돼요.
    }
    return r
  })

  // Claude Code 가 «이 도구를 써도 될까요?» 창을 띄우면 알려요. 자리를 비웠을 때 몇십 분씩 멈춰 있지 않게요.
  // (권한 묻기를 꺼 둔 세션에서는 이 창이 안 떠서 알림도 안 와요)
  on('classic.PermissionRequest', async ($, e, next) => {
    void notifyPermission($, String(e.tool_name ?? ''), e.tool_input)
    return next(e)
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
    const now = await $.clock.now()
    const redraw = () => $.ui.invalidate('ui.render')
    const labelSet = tabLabelSet(inner + 1)
    // 옆이 아니라 입력창 위에 열렸다면(클래식 화면) 마우스가 안 눌려요. 클릭은 풀스크린 화면에서만 와요.
    const inline = e.props.placement === 'inline'
    lastPlacement = e.props.placement
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
          // 클립 탭은 열 때 감시를 시작해요. 메일 탭은 열 때 받은편지함 제목을 읽어요.
          if (name === 'clip') void watchClipboard($)
          if (name === 'mail') void mailOnTab($)
          if (name === 'settings') settingsOnTab($)
        }}
      />
    )
    const body =
      tab === 'pin'
        ? pinTab(els, inner, {
            explain: (path: string) => {
              void $.prompt.fill({ text: changePrompt(path) }).then(r => {
                $.ui.toast(r.isFilled ? '입력창에 넣었어요. Esc로 입력창에 돌아가 엔터를 누르면 물어봐요.' : '입력창에 못 넣었어요.', { timeoutMs: 6000 })
              })
            },
          })
        : tab === 'usage'
          ? usageTab(els, inner, {
              now: () => void startHandoff($, true),
              cycle: () => {
                mode = nextMode(mode)
                void $.store.set('mode', mode)
                redraw()
              },
            })
          : tab === 'mail'
            ? mailTab(els, inner, now, {
                open: (row: MailRow) => void openMail($, row),
                back: () => {
                  mailView = undefined
                  redraw()
                },
                refresh: () => {
                  void loadMailList($)
                  void loadCalendar($)
                },
                connect: () => connectGmail($),
                // 입력창을 이 글로 채우기만 해요. 보내기는 엔터로 해요.
                ask: m => {
                  void $.prompt.fill({ text: mailActionPrompt(m) }).then(r => {
                    $.ui.toast(r.isFilled ? '입력창에 넣었어요. Esc로 입력창에 돌아가 엔터를 누르면 시작해요.' : '입력창에 못 넣었어요.', { timeoutMs: 6000 })
                  })
                },
                browser: url => void openMailInBrowser($, url),
              })
          : tab === 'clip'
            ? clipTab(els, inner, {
                paste: () => {
                  const newest = clipList[0]
                  if (newest) void pasteItem($, newest)
                },
                refresh: () => void readClipList($).then(redraw),
                pick: (item: ClipItem) => void pasteItem($, item),
              })
            : tab === 'cmds'
            ? commandsTab(els, inner, {
                run: (g: Guide) => {
                  void $.prompt.fill({ text: guideCommand(g) }).then(r => {
                    $.ui.toast(r.isFilled ? `입력창에 ${guideCommand(g)} 를 넣었어요. 엔터를 누르면 실행돼요.` : '입력창에 못 넣었어요.', { timeoutMs: 6000 })
                  })
                },
                remove: (g: Guide) => {
                  if (isDefaultGuide(g)) cmdHidden = [...cmdHidden, guideCommand(g)]
                  else cmdAdded = cmdAdded.filter(x => guideCommand(x) !== guideCommand(g))
                  cmdNote = undefined
                  void saveGuide($)
                  redraw()
                },
                add: (text: string) => void addGuide($, text),
                reset: () => {
                  cmdAdded = []
                  cmdHidden = []
                  cmdNote = undefined
                  void saveGuide($)
                  redraw()
                },
              })
          : settingsTab(els, inner, {
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
                  notifyDone: () => {
                    notifyDoneOn = !notifyDoneOn
                    void $.store.set('notifyDone', notifyDoneOn)
                    redraw()
                  },
                  coach: () => {
                    coachOn = !coachOn
                    void $.store.set('coach', coachOn)
                    redraw()
                  },
                  recheck: () => void runChecks($),
                  testNotify: () => {
                    void osNotify($, '알림 시험', '이 알림이 보이면 잘 돼요', true)
                    $.ui.toast('알림을 보냈어요. 안 보이면 점검의 «알림» 줄을 보세요.', { timeoutMs: 6000 })
                  },
                })
    return (
      <Box flexDirection="column" width={inner + 2}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={1}>
          {TABS.map(t => tabBtn(t.name, t.labels[labelSet], t.hotkey))}
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
    // «작업 끝 알림» 스위치를 켰을 때만 알려요(기본 꺼짐). 질문·승인 알림과 따로예요.
    if (notifyDoneOn && !e.isAborted && e.durationMs >= cfg.notifyMinSeconds * 1000) {
      const secs = Math.round(e.durationMs / 1000)
      const took = secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`
      void osNotify($, `작업이 끝났어요 · ${took}`, String(e.answer ?? '').split('\n').find(l => l.trim()) ?? '', true)
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
    if (e.source === 'resume' || e.source === 'fork') {
      await loadBoard($)
      await loadChanges($)
    }
    // 새 대화(/clear·인수인계)는 고친 파일 목록을 비우고 시작해요.
    if (e.source === 'clear') {
      changes = []
      $.ui.invalidate('ui.render')
    }
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
