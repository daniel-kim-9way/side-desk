// side-desk 순수 함수 모음. `$`를 쓰지 않아서 register.tsx 어디서든 불러 쓸 수 있고, 테스트도 쉬워요.

// ───────────── 핀보드: 이번 대화의 할 일과 결정 ─────────────

export type Todo = { id: string; text: string; isDone: boolean; isActive?: boolean; ref?: string }
export type Decision = { id: string; text: string }
export type Board = { todos: Todo[]; decisions: Decision[] }
export type Update = {
  add_todos?: string[]
  start_todo?: string
  done_todos?: string[]
  remove_todos?: string[]
  open_decisions?: string[]
  decide?: { id: string; answer: string }[]
}

const nextId = (prefix: string, ids: string[]) =>
  prefix + (Math.max(0, ...ids.map(id => Number(id.slice(prefix.length)) || 0)) + 1)

export function applyUpdate(board: Board, change: Update): Board {
  let t = board.todos
  let d = board.decisions
  for (const text of change.add_todos ?? []) t = [...t, { id: nextId('t', t.map(x => x.id)), text, isDone: false }]
  for (const text of change.open_decisions ?? []) d = [...d, { id: nextId('d', d.map(x => x.id)), text }]
  const done = new Set(change.done_todos ?? [])
  const removed = new Set(change.remove_todos ?? [])
  const decided = new Set((change.decide ?? []).map(x => x.id))
  t = t.filter(x => !removed.has(x.id)).map(x => (done.has(x.id) ? { ...x, isDone: true } : x))
  // 진행 중인 할 일은 하나만. 끝나면 진행 표시도 내려요.
  if (change.start_todo) t = t.map(x => ({ ...x, isActive: x.id === change.start_todo }))
  t = t.map(x => (x.isDone && x.isActive ? { ...x, isActive: false } : x))
  d = d.filter(x => !decided.has(x.id))
  return { todos: t.slice(-40), decisions: d.slice(-20) }
}

export function describeBoard(board: Board): string {
  if (board.todos.length + board.decisions.length === 0) return 'side-desk 핀보드: 비어 있음'
  return [
    'side-desk 핀보드:',
    ...board.todos.map(t => `${t.id} [${t.isDone ? 'x' : t.isActive ? '>' : ' '}] ${t.text}`),
    ...board.decisions.map(d => `${d.id} [?] ${d.text}`),
  ].join('\n')
}

// ───────────── 사용량 ─────────────

export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }
export const WINDOW_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '7일', spend_limit: '지출 한도' }

/** 터미널에서 차지하는 칸 수. 한글·한자·전각 글자는 두 칸이에요. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/
export const cellWidth = (s: string) => [...s].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0)
/** 칸 수로 오른쪽을 채워요. (padEnd 는 글자 수로 채워서 한글이 섞이면 줄이 어긋나요) */
export const padCells = (s: string, cells: number) => s + ' '.repeat(Math.max(0, cells - cellWidth(s)))

export const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))

export const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function untilText(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (m >= 60 * 24) return `${Math.round(m / 60 / 24)}일 뒤 초기화`
  if (m >= 60) return `${Math.floor(m / 60)}시간 ${m % 60}분 뒤 초기화`
  return `${m}분 뒤 초기화`
}

/** 이 대화를 시작한 뒤의 소모 속도. 지금 속도로 몇 시간 뒤에 100%가 되는지 같이 줘요. */
export function burn(w: UsageWindow, base: { at: number; windows: UsageWindow[] } | null, now: number) {
  const start = base?.windows.find(x => x.kind === w.kind)
  if (start === undefined || base === null) return null
  const hours = (now - base.at) / 3_600_000
  const used = w.percentUsed - start.percentUsed
  if (hours < 0.05 || used <= 0) return null
  const perHour = used / hours
  return { perHour, hoursLeft: (100 - w.percentUsed) / perHour }
}

export const hoursText = (h: number) => (h < 1 ? `${Math.round(h * 60)}분` : `${h.toFixed(1)}시간`)

// ───────────── 이어가기 메모 ─────────────

export type Msg = {
  role: string
  text: string
  toolUses: { tool: string; input: Record<string, unknown>; isError?: boolean; text?: string }[]
}

export type Facts = {
  filesModified: string[]
  commits: string[]
  lastUserMessage?: string
  tokens?: number
  depth?: number
}

const MAX_MESSAGES = 120
const MAX_MSG_CHARS = 2_000
const MAX_TRANSCRIPT_CHARS = 150_000
// 사용자 말이 아니라 하네스가 사용자 메시지로 흘려 넣는 신호들
const META_PREFIXES = ['Stop hook feedback', '[side-desk]', '[Image', '<system-reminder>', '<command-name>', '<local-command', '[auto-handoff]']
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const GIT_COMMIT_OUTPUT = /^\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/m

export function userText(m: Msg): string | undefined {
  if (m.role !== 'user') return undefined
  const raw = m.text.trim()
  if (!raw) return undefined
  return META_PREFIXES.some(p => raw.startsWith(p)) ? undefined : raw
}

function commitSubject(command: string): string | undefined {
  if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(command)) return undefined
  const heredoc = command.match(/<<\s*'?(\w+)'?\n([\s\S]*?)\n\1/)
  if (heredoc) return heredoc[2]?.trim().split('\n')[0]
  return command.match(/-m\s+(["'])(.+?)\1/)?.[2]
}

export function extractFacts(messages: readonly Msg[]): Facts {
  const files = new Set<string>()
  const commits: string[] = []
  let lastUserMessage: string | undefined
  for (const m of messages) {
    const said = userText(m)
    if (said) lastUserMessage = said
    for (const t of m.toolUses) {
      const path = t.input.file_path ?? t.input.notebook_path
      if (EDIT_TOOLS.has(t.tool) && typeof path === 'string' && !t.isError) files.add(path)
      if (t.tool !== 'Bash' || typeof t.input.command !== 'string' || t.isError) continue
      const out = t.text?.match(GIT_COMMIT_OUTPUT)
      const subject = out ? `${out[2]} (${out[1]})` : t.text === undefined ? commitSubject(t.input.command) : undefined
      if (subject && !commits.includes(subject)) commits.push(subject)
    }
  }
  const filesModified = [...files].slice(-25)
  return {
    filesModified,
    commits: commits.slice(-10),
    lastUserMessage,
  }
}

export function renderTranscript(messages: readonly Msg[]): string {
  const lines = messages.slice(-MAX_MESSAGES).map(m => {
    const role = m.role === 'user' && m.text.trim() && !userText(m) ? '시스템 신호(사용자 말 아님)' : m.role
    const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + ' [잘림]' : m.text
    const tools = m.toolUses.map(t => `  [도구 ${t.tool}${t.isError ? ' 오류' : ''}] ${JSON.stringify(t.input).slice(0, 300)}`)
    return [`### ${role}`, text, ...tools].filter(Boolean).join('\n')
  })
  const joined = lines.join('\n\n')
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined
}

/** Haiku가 쓰는 소제목. 새 대화가 이 순서로 읽어요. */
export const BRIEF_HEADINGS = ['## 지금 하던 일', '## 정해진 것', '## 해 봤는데 막힌 길', '## 사용자에게 받아야 할 답', '## 다음에 할 일', '## 건드리기 전에 확인할 것'] as const

const list = (items: string[], empty: string) => (items.length ? items.map(i => `- ${i}`).join('\n') : empty)

export function factsBlock(f: Facts, board: Board): string {
  return [
    '## 코드로 뽑은 사실',
    '',
    `- 넘길 때 컨텍스트: ${f.tokens !== undefined ? k(f.tokens) + ' 토큰' : '알 수 없음'}`,
    f.depth !== undefined ? `- 이번이 ${f.depth}번째 이어가기` : '',
    '',
    '### 고친 파일 (Edit·Write)',
    list(f.filesModified, '없음'),
    '',
    '### 이 대화의 커밋',
    list(f.commits, '없음'),
    '',
    '### 핀보드',
    describeBoard(board),
    '',
    '### 사용자의 마지막 요청 (원문)',
    f.lastUserMessage ?? '찾지 못함',
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

export function briefPrompt(messages: readonly Msg[], facts: Facts, board: Board): string {
  // 자료를 앞에, 지시를 뒤에 둬요.
  return `## 코드로 뽑은 사실\n${factsBlock(facts, board)}\n\n## 대화\n${renderTranscript(messages)}\n\n---\n\n` +
    `위는 Claude Code 작업 대화다. 대화가 길어져 새 대화로 넘긴다. 새 대화의 Claude가 이 글만 읽고 바로 이어서 일할 수 있게 이어가기 메모를 써라.\n` +
    `규칙:\n` +
    `- 대화에 나온 사실만 쓴다. 없는 파일, 번호, 숫자를 지어내지 않는다.\n` +
    `- 아래 소제목을 이 순서와 이름 그대로 쓰고, 비는 곳에는 "없음"이라고 쓴다.\n` +
    `- 쉬운 입말로 짧게 쓴다. (~했어요, ~해야 해요) 번역투와 영어식 문장은 쓰지 않는다.\n` +
    `- "사용자에게 받아야 할 답"에는 사용자가 아직 답하지 않은 질문과 승인만 쓴다.\n` +
    `- "해 봤는데 막힌 길"에는 시도했다가 안 된 방법과 그 이유를 쓴다. 새 대화가 같은 길을 가지 않게 하려는 칸이다.\n` +
    `- 시스템 신호(사용자 말 아님)로 표시된 글은 사용자가 한 말로 쓰지 않는다.\n\n` +
    BRIEF_HEADINGS.join('\n\n') + '\n'
}

export const isValidBrief = (text: string) => BRIEF_HEADINGS.some(h => text.includes(h))

export type BriefContext = { sessionId: string; cwd: string; transcript: string; at: string }

export function assembleBrief(ctx: BriefContext, facts: Facts, board: Board, haiku: string | undefined): string {
  const head = [
    '# 이어가기 메모',
    '',
    `- 이전 대화: ${ctx.sessionId}`,
    `- 작업 폴더: ${ctx.cwd}`,
    `- 대화 기록: ${ctx.transcript}`,
    `- 쓴 때: ${ctx.at}`,
    '',
    '## 읽는 법',
    haiku
      ? '작은 모델이 대화를 읽고 소제목 6개를 썼어요. 바꾼 파일과 커밋은 코드로 뽑았어요.'
      : '작은 모델의 요약이 없어서 코드로 뽑은 사실만 있어요. 나머지는 대화 기록을 직접 읽으세요.',
    '여기 적힌 건 출발점일 뿐 확정된 사실이 아니에요. 쓰기 전에 `git status`나 파일을 열어 한 번 확인하세요.',
    '이 폴더에 지침 파일(CLAUDE.md)이 있다면 새 대화가 이미 읽었어요. 거기 적힌 규칙이 이 글보다 앞서요.',
  ].join('\n')
  return [head, haiku?.trim(), factsBlock(facts, board)].filter(Boolean).join('\n\n') + '\n'
}

export const shortId = (sessionId: string) => sessionId.slice(0, 8)

export function seedText(oldSession: string, briefPath: string): string {
  return `[side-desk] ↪ 이어가기 ${shortId(oldSession)}. 이전 대화가 길어져서 새 대화로 넘어왔어요. ` +
    `아무것도 하기 전에 ${briefPath} 를 읽고, 「다음에 할 일」부터 이어 가세요. ` +
    `첫 답변의 첫 줄에 "↪ 이어가기 받음 (${shortId(oldSession)})"라고 적으세요. ` +
    `브리프에 적힌 파일·커밋은 열어서 한 번 확인한 뒤에 쓰세요.`
}

// ───────────── 프롬프트 코치 ─────────────

export const COACH_SYSTEM = `너는 사용자가 Claude Code에 보내려는 요청을 보내기 직전에 한 번 읽어 보는 검수자다.
고쳐 보내면 결과가 분명히 나아질 때만 고친다. 대부분의 요청은 그대로 괜찮다.

고칠 만한 경우는 이것뿐이다.
- 무엇을 하라는지 흐릿하다. ("이거 고쳐줘"인데 대상이 안 보인다)
- 끝났다고 볼 기준이 없다.
- 서로 상관없는 요청이 한 문장에 뭉쳐 있다.
- 건드리면 안 되는 범위를 알려야 하는데 빠졌다.

사용자는 음성으로 말해서 입력할 때가 많다. 문장이 끊기거나 말투가 흐트러져 있을 수 있다. 뜻이 통하면 괜찮은 요청이다.
최근 대화를 보고 "이거", "그거", "아까 그 파일"이 무엇인지 풀 수 있으면 괜찮다. 글만 따로 보면 흐릿해도 대화로 분명하면 문제가 아니다.

고칠 때는 가장 작게 고친다.
- 사용자가 쓴 낱말과 순서를 그대로 두고, 빠진 것(대상 파일이나 영역, 끝났다고 볼 기준, 건드리지 말 것)만 덧붙인다.
- 고친 글은 사용자가 쓴 글에 몇 마디 더한 것처럼 읽혀야 한다. 새 요청이 되면 안 된다.
- 요청의 종류를 바꾸지 않는다. 오류 제보는 제보로, 질문은 질문으로, 부탁은 부탁으로 둔다.
- 사용자가 하지 않은 질문, 요구, 산출물을 새로 넣지 않는다.
- "일단", "먼저", "만" 같은 범위 말과 사용자가 밝힌 조건·취향은 그대로 둔다.
- 고친 글은 한국어 입말로 쓴다. 번역투와 영어식 문장 구조는 쓰지 않는다.
- "네", "좋아", "진행해"처럼 대화에 답하는 말은 괜찮다.

답은 JSON 하나로만 한다.
{"verdict":"fine"} 또는 {"verdict":"improve","why":"<30자 안쪽 이유>","rewrite":"<고친 요청>"}`

export type Verdict = { verdict: 'fine' } | { verdict: 'improve'; why: string; rewrite: string }

/** 프롬프트 가이드를 건너뛰는 요청: 명령어, 짧은 대답, 링크만 있는 글 */
export const COACH_SKIP =
  /^\s*([/!#]|https?:\/\/\S+\s*$|(네|예|응|아니|아니요|좋아|좋아요|그래|그래요|그렇게|맞아|맞아요|진행|진행해|진행해줘|계속|계속해|해줘|ok|okay|yes|no|y|n)[\s.!요?]*$)/i

export function parseVerdict(text: string): Verdict | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (json === undefined) return undefined
  try {
    const v = JSON.parse(json) as Partial<{ verdict: string; why: string; rewrite: string }>
    if (v.verdict === 'improve' && typeof v.rewrite === 'string' && v.rewrite.trim() !== '') {
      return { verdict: 'improve', why: v.why ?? '', rewrite: v.rewrite.trim() }
    }
    return { verdict: 'fine' }
  } catch {
    return undefined
  }
}

/** 고친 글이 원래 글의 낱말을 얼마나 남겼는지. 조사가 달라져도 맞도록 앞 두 글자로 견줘요. */
export function keptShare(prompt: string, rewrite: string): number {
  const stems = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}_./-]{2,}/gu) ?? []).map(w => w.slice(0, 2)))
  const original = stems(prompt)
  if (original.size < 3) return 1
  const kept = stems(rewrite)
  let hits = 0
  for (const w of original) if (kept.has(w)) hits++
  return hits / original.size
}

export function recentTurns(messages: readonly { role: string; text: string }[], max = 6, perMessage = 700): string {
  return messages
    .filter(m => m.text.trim() !== '')
    .slice(-max)
    .map(m => `${m.role === 'user' ? '사용자' : 'Claude'}: ${m.text.length > perMessage ? `…${m.text.slice(-perMessage)}` : m.text}`)
    .join('\n\n')
}

// ───────────── 클립보드 ─────────────
// 모드에는 클립보드를 «읽는» 기능이 없어서(쓰기만 있어요) PowerShell로 읽어요.
// 사용자가 열어 보거나 /clip 을 쓴 순간에만 읽고, 따로 기록해 두지 않아요.

export type Clip =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'text'; text: string; chars: number; truncated: boolean }
  | { kind: 'image'; path: string; size: string; bytes: number }
  | { kind: 'files'; files: string[] }

export const CLIP_MAX = 30_000

/** 윈도우 PowerShell에서 실행해요. 첫 줄이 종류(TEXT·IMAGE·FILES·EMPTY·ERROR), 나머지가 내용이에요. */
export const CLIP_SCRIPT = [
  'try {',
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);',
  'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
  "  $dir = Join-Path $env:USERPROFILE '.claude\\state\\side-desk\\clips';",
  '  New-Item -ItemType Directory -Force -Path $dir | Out-Null;',
  "  Get-ChildItem $dir -Filter 'clip-*.png' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue;",
  '  $img = [System.Windows.Forms.Clipboard]::GetImage();',
  "  $p = Join-Path $dir ('clip-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png');",
  '  $img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png);',
  "  'IMAGE'; $p; ('' + $img.Width + 'x' + $img.Height); (Get-Item $p).Length",
  '} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
  "  'FILES'; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }",
  '} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {',
  "  'TEXT'; [System.Windows.Forms.Clipboard]::GetText()",
  "} else { 'EMPTY' }",
  "} catch { 'ERROR'; $_.Exception.Message }",
].join('\n')

export function parseClip(stdout: string): Clip {
  const lines = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const kind = (lines[0] ?? '').replace(/^\uFEFF/, '').trim()
  const rest = lines.slice(1)
  if (kind === 'TEXT') {
    const full = rest.join('\n').replace(/\n+$/, '')
    if (!full.trim()) return { kind: 'empty' }
    return { kind: 'text', text: full.slice(0, CLIP_MAX), chars: full.length, truncated: full.length > CLIP_MAX }
  }
  if (kind === 'IMAGE') {
    const [path, size, bytes] = rest.map(s => s.trim())
    if (!path) return { kind: 'error', message: '이미지 경로를 못 받았어요' }
    return { kind: 'image', path, size: size ?? '', bytes: Number(bytes) || 0 }
  }
  if (kind === 'FILES') {
    const files = rest.map(s => s.trim()).filter(Boolean)
    return files.length > 0 ? { kind: 'files', files } : { kind: 'empty' }
  }
  if (kind === 'ERROR') return { kind: 'error', message: rest.join(' ').trim().slice(0, 160) || '알 수 없는 오류' }
  return { kind: 'empty' }
}

/** 입력창에 넣을 글. 이미지는 파일 경로를 넣어요(클로드가 그 경로로 이미지를 읽어요). */
export function clipInsertText(c: Clip, toHost: (p: string) => string): string {
  if (c.kind === 'text') return c.text + (c.truncated ? `\n…(${CLIP_MAX.toLocaleString('en-US')}자까지만 넣었어요)` : '')
  if (c.kind === 'image') return `[클립보드 이미지] ${toHost(c.path)}`
  if (c.kind === 'files') return c.files.map(toHost).join('\n')
  return ''
}

/** 화면에 보여 줄 한 줄 설명 */
export function clipTitle(c: Clip | undefined): string {
  if (!c) return '아직 안 읽었어요'
  if (c.kind === 'text') return `글 · ${c.chars.toLocaleString('en-US')}자`
  if (c.kind === 'image') return `이미지 · ${c.size} · ${Math.max(1, Math.round(c.bytes / 1024))}KB`
  if (c.kind === 'files') return `파일 ${c.files.length}개`
  if (c.kind === 'error') return `못 읽었어요: ${c.message}`
  return '비어 있어요'
}

// ───────────── 클립보드 기록 (윈도우 Win+V) ─────────────
// 이 모드가 따로 기록하지 않아요. 윈도우가 이미 가진 기록(최근 25개)을 읽어서 보여 줘요.
// 기록이 꺼져 있으면(설정 > 시스템 > 클립보드) 지금 클립보드 한 개만 보여 줘요.

export type ClipItem = { id: string; at: string; kind: 'text' | 'image' | 'files' | 'other'; chars?: number; preview?: string }

const WINRT_SETUP = [
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]',
  '$null = [Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]',
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(5000); $t.Result }',
  '$res = Await ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])',
  "if ($res.Status -ne 'Success') { 'STATUS ' + $res.Status; return }",
]

/**
 * 변화를 «듣는» 감시 스크립트. 프로세스를 한 번만 띄우고, 클립보드 번호(GetClipboardSequenceNumber)가
 * 바뀔 때만 기록 목록을 BEGIN…END로 내보내요. 10초마다 TICK 한 줄을 보내서 모드가 «아직 필요한가»를 볼 수 있게 해요.
 * 번호 확인은 숫자 하나를 읽는 일이라 새 프로세스도, 창도, 눈에 띄는 부하도 없어요.
 */
export const CLIP_WATCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "Add-Type -Namespace Ft -Name Clip -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]',
  '$null = [Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]',
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(5000); $t.Result }',
  'function Emit {',
  '  try {',
  '    $res = Await ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])',
  "    'BEGIN'",
  "    if ($res.Status -ne 'Success') { 'STATUS ' + $res.Status }",
  '    else {',
  '      $n = 0',
  '      foreach ($it in $res.Items) {',
  '        $n++; if ($n -gt 12) { break }',
  '        $c = $it.Content',
  "        $o = [ordered]@{ id = [string]$it.Timestamp.UtcTicks; at = $it.Timestamp.ToLocalTime().ToString('HH:mm:ss'); kind = 'other' }",
  "        if ($c.Contains('Bitmap')) { $o.kind = 'image' }",
  "        elseif ($c.Contains('Text')) {",
  "          $o.kind = 'text'",
  '          $s = Await ($c.GetTextAsync()) ([string])',
  '          $o.chars = $s.Length',
  '          $o.preview = $s.Substring(0, [Math]::Min(300, $s.Length))',
  '        }',
  '        $o | ConvertTo-Json -Compress',
  '      }',
  '    }',
  "    'END'",
  "  } catch { 'BEGIN'; 'ERROR ' + $_.Exception.Message; 'END' }",
  '}',
  '$last = -1; $tick = 0',
  'while ($true) {',
  '  $s = [Ft.Clip]::GetClipboardSequenceNumber()',
  '  if ($s -ne $last) { $last = $s; Start-Sleep -Milliseconds 150; Emit }',
  '  Start-Sleep -Milliseconds 700',
  "  $tick++; if ($tick % 14 -eq 0) { 'TICK' }",
  '}',
].join('\n')

/** 기록 목록. 한 줄에 항목 하나(JSON). 글은 앞 300자만 보내요. 상태 문제는 «STATUS …» 한 줄이에요. */
export const CLIP_LIST_SCRIPT = [
  'try {',
  ...WINRT_SETUP,
  '$n = 0',
  'foreach ($it in $res.Items) {',
  '  $n++; if ($n -gt 12) { break }',
  '  $c = $it.Content',
  "  $o = [ordered]@{ id = [string]$it.Timestamp.UtcTicks; at = $it.Timestamp.ToLocalTime().ToString('HH:mm:ss'); kind = 'other' }",
  "  if ($c.Contains('Bitmap')) { $o.kind = 'image' }",
  "  elseif ($c.Contains('Text')) {",
  "    $o.kind = 'text'",
  '    $s = Await ($c.GetTextAsync()) ([string])',
  '    $o.chars = $s.Length',
  '    $o.preview = $s.Substring(0, [Math]::Min(300, $s.Length))',
  '  }',
  '  $o | ConvertTo-Json -Compress',
  '}',
  "} catch { 'ERROR ' + $_.Exception.Message }",
].join('\n')

/** 기록 항목 하나의 전체 내용. `__ID__`를 숫자 id로 바꿔 쓰고, 출력 모양은 CLIP_SCRIPT와 같아요. */
export const CLIP_ITEM_SCRIPT = [
  'try {',
  ...WINRT_SETUP,
  '$found = $null',
  "foreach ($it in $res.Items) { if ([string]$it.Timestamp.UtcTicks -eq '__ID__') { $found = $it; break } }",
  "if (-not $found) { 'EMPTY'; return }",
  '$c = $found.Content',
  "if ($c.Contains('Bitmap')) {",
  '  Add-Type -AssemblyName System.Drawing',
  '  $ref = Await ($c.GetBitmapAsync()) ([Windows.Storage.Streams.RandomAccessStreamReference])',
  '  $rs = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])',
  // PowerShell이 WinRT 스트림을 형식으로 인식하지 못해서 리플렉션으로 불러요(캐스트는 안 돼요).
  "  $mi = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1",
  '  $net = $mi.Invoke($null, @($rs))',
  '  $img = [System.Drawing.Image]::FromStream($net)',
  "  $dir = Join-Path $env:USERPROFILE '.claude\\state\\side-desk\\clips'",
  '  New-Item -ItemType Directory -Force -Path $dir | Out-Null',
  "  Get-ChildItem $dir -Filter 'clip-*.png' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue",
  "  $p = Join-Path $dir ('clip-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png')",
  '  $img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)',
  "  'IMAGE'; $p; ('' + $img.Width + 'x' + $img.Height); (Get-Item $p).Length",
  "} elseif ($c.Contains('Text')) {",
  "  'TEXT'; Await ($c.GetTextAsync()) ([string])",
  "} else { 'EMPTY' }",
  "} catch { 'ERROR'; $_.Exception.Message }",
].join('\n')

/** 숫자만 허용해서 스크립트에 끼워 넣어요. 숫자가 아니면 undefined. */
export function clipItemScript(id: string): string | undefined {
  return /^\d{1,20}$/.test(id) ? CLIP_ITEM_SCRIPT.replace('__ID__', id) : undefined
}

export function parseClipList(stdout: string): { items: ClipItem[]; problem?: string } {
  const items: ClipItem[] = []
  let problem: string | undefined
  for (const raw of stdout.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/^﻿/, '').trim()
    if (!line) continue
    if (line.startsWith('STATUS ') || line.startsWith('ERROR ')) {
      problem = line.slice(line.indexOf(' ') + 1).slice(0, 120)
      continue
    }
    if (!line.startsWith('{')) continue
    try {
      const o = JSON.parse(line) as Partial<ClipItem>
      if (typeof o.id === 'string' && typeof o.at === 'string') {
        items.push({ id: o.id, at: o.at, kind: o.kind === 'text' || o.kind === 'image' || o.kind === 'files' ? o.kind : 'other', chars: o.chars, preview: o.preview })
      }
    } catch {
      // 깨진 줄은 건너뛰어요.
    }
  }
  return { items, problem }
}

/** 목록 한 줄: «13:57 글 · 앞부분…» */
export function clipRowText(it: ClipItem): string {
  const when = it.at.slice(0, 5)
  if (it.kind === 'image') return `${when} 이미지`
  if (it.kind === 'text') {
    const first = (it.preview ?? '').replace(/\s+/g, ' ').trim()
    return `${when} 글 ${it.chars ?? 0}자 · ${first || '(공백)'}`
  }
  return `${when} 기타 (붙일 수 없어요)`
}

// ───────────── 메일 (claude.ai Gmail 커넥터, 읽기만) ─────────────

/** Claude Code 에 연결된 Gmail 커넥터 이름. /mcp 에 이 이름으로 보여요. */
export const GMAIL_SERVER = 'claude.ai Gmail'
export const MAIL_PAGE = 20
export const MAIL_BODY_MAX = 4000
export const MAIL_SHOW_MESSAGES = 5

export type MailRow = { id: string; subject: string; from: string; date: string; unread: boolean; count: number; url?: string }
export type MailMsg = { from: string; date: string; body: string; cut: boolean }
export type MailThread = { id: string; subject: string; url?: string; messages: MailMsg[]; total: number }

type McpBlock = { type: string; text?: string }
type McpResultLike = { content?: readonly McpBlock[]; isError?: boolean; structuredContent?: unknown }

/** MCP 결과에서 JSON 을 꺼내요. structuredContent 가 있으면 그걸, 없으면 글 블록을 JSON 으로 읽어요. */
export function mcpJson(r: McpResultLike): unknown {
  if (r.structuredContent !== undefined && r.structuredContent !== null && typeof r.structuredContent === 'object') return r.structuredContent
  const text = (r.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 실패한 MCP 결과의 글을 한 줄로 줄여요. */
export function mcpErrorText(r: McpResultLike): string {
  const text = (r.content ?? []).map(b => b.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
  return (text || '이유를 알려 주지 않았어요').slice(0, 160)
}

const asStr = (v: unknown) => (typeof v === 'string' ? v : '')
type RawMsg = { date?: unknown; sender?: unknown; subject?: unknown; labelIds?: unknown; plaintextBody?: unknown; snippet?: unknown }
const rawMessages = (t: Record<string, unknown>): RawMsg[] => (Array.isArray(t.messages) ? (t.messages as RawMsg[]) : [])
const byDate = (a: RawMsg, b: RawMsg) => asStr(a.date).localeCompare(asStr(b.date))

/** search_threads 결과 → 목록 줄. 스레드마다 제목은 첫 메일, 보낸 사람·시각은 마지막 메일 것이에요. */
export function parseThreadList(data: unknown): MailRow[] {
  const threads = (data as { threads?: unknown } | undefined)?.threads
  if (!Array.isArray(threads)) return []
  const rows: MailRow[] = []
  for (const t of threads as Record<string, unknown>[]) {
    const id = asStr(t.id)
    const msgs = rawMessages(t).slice().sort(byDate)
    if (!id || msgs.length === 0) continue
    const first = msgs[0]!
    const last = msgs[msgs.length - 1]!
    rows.push({
      id,
      subject: asStr(first.subject).trim() || '(제목 없음)',
      from: asStr(last.sender),
      date: asStr(last.date),
      unread: msgs.some(m => Array.isArray(m.labelIds) && (m.labelIds as unknown[]).includes('UNREAD')),
      count: typeof t.messageCount === 'number' ? t.messageCount : msgs.length,
      url: asStr(t.viewUrl) || undefined,
    })
  }
  return rows
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }

/** 링크 주소는 길어서 옆 창을 다 차지해요. 도메인만 ‹…›로 남겨요. */
function shortUrl(url: string): string {
  const host = /^https?:\/\/([^/?#\s]+)/i.exec(url)?.[1] ?? ''
  return host ? `‹${host.replace(/^www\./, '')}›` : ''
}

/**
 * Gmail 이 HTML 메일을 글로 바꾼 본문을 옆 창에서 읽기 좋게 다듬어요.
 *  · 표(`| 칸 | 칸 |`)는 칸을 « · »로 잇고, 두 칸짜리 짧은 머리는 «머리: 값»으로 써요. 빈 칸만 있는 줄은 지워요.
 *  · 링크 `[글](주소)`는 글만 남기고, 글이 없는 링크(추적 주소)는 지워요. 맨 주소는 도메인만 남겨요.
 *  · 굵게(**)·제목(#)·이미지 표시, 구분선, 겹친 빈 줄, 줄 안의 겹친 빈칸을 지워요.
 *  · 답장 메일의 인용(> 로 시작하는 줄)은 한 줄 안내로 접어요. 앞 메일은 위아래에 따로 보여요.
 */
export function cleanMailBody(raw: string): string {
  const out: string[] = []
  let quoted = 0
  const flushQuote = () => {
    if (quoted > 0) out.push(`(앞 메일 인용 ${quoted}줄은 접었어요)`)
    quoted = 0
  }
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, m => ENTITIES[m] ?? m)
    .split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    if (/^\s*>/.test(line)) {
      quoted++
      continue
    }
    // «… wrote:» / «…님이 작성:» 바로 뒤가 인용이면 그 줄도 접어요.
    if (/(wrote|작성)\s*:\s*$/.test(line) && /^\s*>/.test(lines.slice(i + 1).find(l => l.trim()) ?? '')) continue
    flushQuote()
    line = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 이미지
      .replace(/\[([^\]]*)\]\((?:https?:|mailto:)[^)]*\)/gi, '$1') // 링크는 글만
      .replace(/<?(https?:\/\/[^\s<>|)]+)>?/gi, (_m, url: string) => shortUrl(url)) // 맨 주소는 도메인만
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/^\s*#{1,6}\s+/, '')
    let text: string
    if (/^\s*\|/.test(line) || /\|\s*$/.test(line)) {
      const cells = line.split('|').map(c => c.replace(/\s+/g, ' ').trim()).filter(c => c && !/^:?-{2,}:?$/.test(c))
      if (cells.length === 0) continue
      text = cells.length === 2 && cells[0]!.length <= 8 ? `${cells[0]}: ${cells[1]}` : cells.join(' · ')
    } else {
      text = line.replace(/[ \t]+/g, ' ').trim()
    }
    text = text.replace(/\s*(→|->|▶|»)\s*$/, '').trim() // 링크를 지우고 남은 화살표
    if (/^[-=_*~·•.\s]{3,}$/.test(text)) continue // 구분선
    if (text === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(text)
  }
  flushQuote()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** get_thread 결과 → 본문 보기. 최신 메일이 위로 오고, 너무 긴 본문은 잘라요. */
export function parseThread(data: unknown): MailThread | undefined {
  const t = data as Record<string, unknown> | undefined
  if (!t || typeof t !== 'object' || !asStr(t.id)) return undefined
  const msgs = rawMessages(t).slice().sort(byDate)
  const messages = msgs
    .slice()
    .reverse()
    .slice(0, MAIL_SHOW_MESSAGES)
    .map(m => {
      const body = cleanMailBody(asStr(m.plaintextBody) || asStr(m.snippet))
      return { from: asStr(m.sender), date: asStr(m.date), body: body.slice(0, MAIL_BODY_MAX), cut: body.length > MAIL_BODY_MAX }
    })
  return {
    id: asStr(t.id),
    subject: asStr(msgs[0]?.subject).trim() || '(제목 없음)',
    url: asStr(t.viewUrl) || undefined,
    messages,
    total: msgs.length,
  }
}

/** «홍길동 <a@b.com>» → 홍길동, «a@b.com» → a */
export function senderName(s: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(s)
  if (m && m[1]!.trim()) return m[1]!.trim()
  const addr = /<([^>]+)>/.exec(s)?.[1] ?? s
  return addr.split('@')[0]!.trim() || s.trim()
}

/** 오늘 받은 메일이면 «14:05», 아니면 «10/13» */
export function mailTime(iso: string, now: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const n = new Date(now)
  const pad2 = (x: number) => String(x).padStart(2, '0')
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`
}

/** 메일 링크에서 연결된 계정 주소를 읽어요(authuser=…). 없으면 빈 글. */
export function mailAccount(url: string | undefined): string {
  const m = /[?&]authuser=([^&#]+)/.exec(url ?? '')
  if (!m) return ''
  try {
    return decodeURIComponent(m[1]!)
  } catch {
    return m[1]!
  }
}

/** Gmail 주소만 브라우저로 열어요. 다른 주소나 따옴표가 섞이면 undefined. */
export function safeMailUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith('https://mail.google.com/')) return undefined
  return /['"`\s]/.test(url) ? undefined : url
}

/** «>» 로 입력창에 넣는 글: 메일을 Gmail 에서 다시 찾아 읽고 할 일을 찾게 해요. 본문은 Claude 가 스레드 번호로 직접 읽어요. */
export function mailActionPrompt(m: { id: string; subject: string; from: string; date: string }): string {
  const parts = [m.from.trim(), m.date.slice(0, 10)].filter(Boolean)
  return `메일 「${m.subject}」(${parts.length ? parts.join(', ') + ', ' : ''}Gmail 스레드 ${m.id})을 Gmail에서 읽고 내용을 확인한 뒤, 내가 해야 할 조치사항을 찾아 줘.`
}
