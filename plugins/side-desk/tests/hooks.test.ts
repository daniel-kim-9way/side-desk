import { expect, mock, test } from 'claude-code/testing'

const USAGE = { startedAt: 0, rateLimits: [], cost: null, context: { tokens: 1000, window: 1_000_000, percent: 0.1 } }
const PS_ABS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

// 기본 답변들. surfaces 로 «화면 있는 세션»과 «화면 없는 실행»을 가려요.
function stub(on: any, surfaces: string[], choice: string, env: Record<string, string> = {}, procOut: (argv: string[]) => string = () => '') {
  const clock = mock.clock(on)
  const asked: string[] = []
  const ran: string[] = []
  const runs: string[][] = []
  const filled: { text: string; mode?: string }[] = []
  const opened: any[] = []
  const kv = new Map<string, unknown>()
  const usage = { tokens: 1000 }
  on('session.surfaces', () => ({ value: surfaces }))
  on('env.get', ($: any, e: any) => {
    const name = e.name ?? e.key
    return { value: env[name] ?? (name === 'OS' ? 'Windows_NT' : undefined) }
  })
  on('fs.exists', ($: any, e: any) => ({ value: String(e.path).replace(/\\/g, '/').endsWith('WindowsPowerShell/v1.0/powershell.exe') }))
  on('store.get', ($: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'abc12345-test' }))
  on('session.usage', () => ({
    value: { ...USAGE, context: { tokens: usage.tokens, window: 1_000_000, percent: usage.tokens / 10_000 } },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: procOut(e.argv), stderr: '' } }
  })
  on('prompt.fill', ($: any, e: any) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  // 확인창(AskUserQuestion)에는 choice 로 답하고, 나머지 도구는 «실행됨»으로 답해요.
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(e.questions[0].question)
      return { result: { answers: { [e.questions[0].question]: choice } } }
    }
    ran.push(e.tool)
    return { result: 'ran' }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.write', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: '## 지금 하던 일\n없음', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  return { clock, asked, ran, runs, filled, opened, kv, usage }
}

// ───────────── 보내기 전 확인 ─────────────

test('화면 있음: 메일 보내기는 내용을 보여 주고 물어요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내지 않기')
  const out = await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'a@b.com', subject: '견적서', body: '안녕하세요' })
  expect(out.deny).toMatch(/보내지 않기로/)
  expect(s.asked[0]).toMatch(/a@b\.com/)
  expect(s.asked[0]).toMatch(/견적서/)
  expect(s.ran).toEqual([])
})

test('화면 있음: 보내기를 허락하면 나가요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기')
  const out = await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'a@b.com', subject: 'x', body: 'y' })
  expect(out.result).toBe('ran')
  expect(s.ran).toEqual(['mcp__claude_ai_Gmail__send_message'])
})

test('화면 있음: 읽기·초안·일반 도구는 묻지 않아요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기')
  await $.tool.call({ tool: 'mcp__claude_ai_Gmail__search_threads', query: 'is:unread' })
  await $.tool.call({ tool: 'mcp__claude_ai_Gmail__create_draft', to: 'a@b.com' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(s.asked.length).toBe(0)
  expect(s.ran.length).toBe(3)
})

test('화면 없음(예약 작업 등): 바깥 발송은 보내지 않아요', async ($, on) => {
  const s = stub(on, [], '보내기')
  const out = await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'a@b.com', subject: 'x', body: 'y' })
  expect(out.deny).toMatch(/화면에 없어서/)
  expect(s.asked.length).toBe(0)
  expect(s.ran).toEqual([])
})

test('설정에서 «보내기 전 확인»을 끄면 묻지 않아요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기')
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  s.kv.set('sendConfirm', false)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'a@b.com', subject: 'x', body: 'y' })
  expect(out.result).toBe('ran')
  expect(s.asked.length).toBe(0)
})

// ───────────── 알림 ─────────────

test('알림: 60초 넘게 걸린 일이 끝나면 윈도우 알림을 띄워요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기')
  await $.turn.complete({ turnId: 't1', answer: '보고서를 만들었어요\n자세한 내용은…', durationMs: 90_000, isAborted: false, usage: null })
  await s.clock.advance(0)
  const call = s.runs.find(a => /powershell/.test(a[0]))
  expect(call).toBeDefined()
  expect(call!.join(' ')).toMatch(/작업이 끝났어요 · 1분 30초/)
  expect(call!.join(' ')).toMatch(/보고서를 만들었어요/)
})

test('알림: 짧은 일은 조용해요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기')
  await $.turn.complete({ turnId: 't2', answer: '네', durationMs: 5_000, isAborted: false, usage: null })
  await s.clock.advance(0)
  expect(s.runs.length).toBe(0)
})

// ───────────── 클립보드 (/clip) ─────────────

const clipOut = (text: string) => (argv: string[]) => (argv.includes('-STA') ? text : '')

async function runClip($: any, s: any) {
  const out = await $.command.run({ command: 'clip', args: '' })
  await s.clock.advance(200)
  return out
}

test('/clip: 글은 입력창의 커서 자리(insert)에 그대로 들어가요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기', {}, clipOut('TEXT\n안녕하세요\n두 번째 줄\n'))
  await runClip($, s)
  expect(s.filled.length).toBe(1)
  expect(s.filled[0].text).toBe('안녕하세요\n두 번째 줄')
  expect(s.filled[0].mode).toBe('insert')
})

test('/clip: 이미지는 저장된 파일 경로를 넣어요 (윈도우)', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기', {}, clipOut('IMAGE\nC:\\Users\\me\\.claude\\state\\side-desk\\clips\\clip-1.png\n800x600\n123456\n'))
  await runClip($, s)
  expect(s.filled[0].text).toBe('[클립보드 이미지] C:/Users/me/.claude/state/side-desk/clips/clip-1.png')
})

test('/clip: 비어 있으면 아무것도 넣지 않고 알려요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기', {}, clipOut('EMPTY\n'))
  const out = await $.command.run({ command: 'clip', args: '' })
  await s.clock.advance(200)
  expect(out.text).toMatch(/비어 있어요/)
  expect(s.filled.length).toBe(0)
})

test('/clip: 화면 없는 실행에서는 읽지 않아요', async ($, on) => {
  const s = stub(on, [], '보내기', {}, clipOut('TEXT\n비밀번호\n'))
  const out = await $.command.run({ command: 'clip', args: '' })
  expect(out.text).toMatch(/화면이 있는 세션/)
  expect(s.runs.some(a => a.includes('-STA'))).toBe(false)
})

// ───────────── WSL ─────────────

// WSL 안인데 OS=Windows_NT 가 같이 넘어오는 경우도 있어요. WSL_DISTRO_NAME 이 있으면 WSL로 봐요.
const WSL_ENV = { OS: 'Windows_NT', WSL_DISTRO_NAME: 'Ubuntu-24.04' }

test('WSL: 윈도우의 powershell.exe 를 전체 경로로 부르고, 이미지 경로를 /mnt/c 로 바꿔요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기', WSL_ENV,
    (argv: string[]) => (argv.includes('-STA') ? 'IMAGE\nC:\\Users\\me\\.claude\\state\\side-desk\\clips\\clip-2.png\n10x10\n99\n' : ''))
  await runClip($, s)
  const run = s.runs.find(a => a.includes('-STA'))
  expect(run![0]).toBe(PS_ABS)
  expect(s.filled[0].text).toBe('[클립보드 이미지] /mnt/c/Users/me/.claude/state/side-desk/clips/clip-2.png')
})

// ───────────── 대화 이어가기 ─────────────

async function flush(s: any) {
  for (let i = 0; i < 40; i++) await s.clock.advance(0)
}

async function turn($: any, s: any, tokens: number) {
  s.usage.tokens = tokens
  await $.turn.complete({ turnId: 't' + tokens, answer: '네', durationMs: 1000, isAborted: false, usage: null })
  await flush(s)
}

const asksHandoff = (s: any) => s.asked.filter((q: string) => /새 대화로 넘길까요/.test(q)).length

test('이어가기: 기준 아래에서는 묻지 않아요', async ($, on) => {
  const s = stub(on, ['terminal'], '이 대화 계속')
  await turn($, s, 180_000)
  await turn($, s, 399_000)
  expect(asksHandoff(s)).toBe(0)
})

test('이어가기: 기준을 넘으면 한 번 묻고, 같은 대화에서는 다시 묻지 않아요', async ($, on) => {
  const s = stub(on, ['terminal'], '이 대화 계속')
  await turn($, s, 410_000)
  expect(asksHandoff(s)).toBe(1)
  await turn($, s, 450_000)
  await turn($, s, 600_000)
  expect(asksHandoff(s)).toBe(1)
})

test('이어가기: 화면 없는 실행에서는 묻지 않아요', async ($, on) => {
  const s = stub(on, [], '이 대화 계속')
  await turn($, s, 600_000)
  expect(s.asked.length).toBe(0)
})

// ───────────── 자동 열기 ─────────────

test('자동 열기는 기본이 꺼져 있어요', async ($, on) => {
  const s = stub(on, ['terminal'], '보내기')
  await $.classic.SessionStart({ source: 'startup' })
  await s.clock.advance(0)
  expect(s.opened.length).toBe(0)
})

// ───────────── 승인 기다릴 때 알림 · 맥·리눅스 알림 ─────────────

function stubPerm(on: any, env: Record<string, string> = {}) {
  const s = stub(on, ['terminal'], '진행하기', env)
  const notes: { text: string; title?: string }[] = []
  on('classic.PermissionRequest', () => ({}))
  on('ui.notify', ($: any, e: any) => {
    notes.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'terminal' } }
  })
  const ask = async ($: any, tool_name: string, tool_input: unknown) => {
    await $.classic.PermissionRequest({ hook_event_name: 'PermissionRequest', tool_name, tool_input, session_id: 's', transcript_path: '', cwd: '/work' })
    await s.clock.advance(0)
  }
  return { ...s, notes, ask }
}

test('승인 대기: Claude Code 가 승인 창을 띄우면 무엇을 하려는지 알림으로 알려요', async ($, on) => {
  const s = stubPerm(on)
  await s.ask($, 'Bash', { command: 'npm install left-pad' })
  const call = s.runs.find(a => a[0] === 'powershell')
  expect(call).toBeDefined()
  expect(call!.join(' ')).toMatch(/승인을 기다려요/)
  expect(call!.join(' ')).toMatch(/npm install left-pad/)
})

test('승인 대기: 질문(AskUserQuestion)은 따로 알리니 승인 알림을 또 보내지 않아요', async ($, on) => {
  const s = stubPerm(on)
  await s.ask($, 'AskUserQuestion', { questions: [] })
  expect(s.runs.length).toBe(0)
})

test('승인 대기: 같은 승인 창이 10초 안에 또 뜨면 한 번만 알려요', async ($, on) => {
  const s = stubPerm(on)
  await s.ask($, 'Bash', { command: 'make' })
  await s.ask($, 'Bash', { command: 'make' })
  expect(s.runs.length).toBe(1)
  await s.clock.advance(11_000)
  await s.ask($, 'Bash', { command: 'make' })
  expect(s.runs.length).toBe(2)
})

test('승인 대기: 화면 없는 실행에서는 알리지 않아요', async ($, on) => {
  const s = stub(on, [], '진행하기')
  on('classic.PermissionRequest', () => ({}))
  await $.classic.PermissionRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'make' }, session_id: 's', transcript_path: '', cwd: '/work' })
  await s.clock.advance(0)
  expect(s.runs.length).toBe(0)
})

test('맥·리눅스: 알림은 PowerShell 대신 Claude Code 의 터미널 알림으로 보내요', async ($, on) => {
  const s = stubPerm(on, { OS: '' })
  await $.turn.complete({ turnId: 'm1', answer: '정리를 끝냈어요', durationMs: 90_000, isAborted: false, usage: null })
  await s.clock.advance(0)
  expect(s.runs.length).toBe(0)
  expect(s.notes).toEqual([{ text: '정리를 끝냈어요', title: '작업이 끝났어요 · 1분 30초' }])
  await s.ask($, 'Write', { file_path: '/w/a.md' })
  expect(s.notes[1]).toEqual({ text: 'Write: /w/a.md', title: '승인을 기다려요' })
})
