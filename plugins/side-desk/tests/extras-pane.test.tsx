import { expect, mock, test } from 'claude-code/testing'

// 0.3.0 에 더한 화면: 할 일 탭의 «이번 대화에서 고친 파일», 설정 탭의 «점검»과 «자주 쓰는 명령».

const PANE = {
  plugin: 'side-desk',
  component: 'Pane',
  requestId: 'side-desk',
  viewport: { columns: 100, rows: 30 },
  props: { title: '책상', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const USAGE = { startedAt: 0, rateLimits: [], cost: null, context: { tokens: 1000, window: 1_000_000, percent: 0.1 } }
const ok = (o: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(o) }], isError: false } })

function stub(on: any, opts: { version?: string; calendar?: 'ok' | 'permission'; env?: Record<string, string> } = {}) {
  const clock = mock.clock(on)
  const filled: string[] = []
  const runs: string[][] = []
  const notes: { text: string; title?: string }[] = []
  const kv = new Map<string, unknown>()
  on('env.get', ($: any, e: any) => {
    const name = e.name ?? e.key
    return { value: opts.env ? opts.env[name] : name === 'OS' ? 'Windows_NT' : undefined }
  })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('store.get', ($: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'abc12345-test' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: opts.version ?? '2.1.300', base: opts.version ?? '2.1.300' } }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'side-desk', title: '책상', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.notify', ($: any, e: any) => {
    notes.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'terminal' } }
  })
  on('prompt.fill', ($: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('mcp.call', ($: any, e: any) => {
    if (e.server === 'claude.ai Google Calendar' && opts.calendar === 'permission') {
      return { deny: `$.mcp.call(claude.ai Google Calendar, list_events) refused: Claude requested permissions to use mcp__claude_ai_Google_Calendar__list_events, but you haven't granted it yet.` }
    }
    return ok(e.server === 'claude.ai Gmail' ? { threads: [] } : { events: [] })
  })
  // 실제 도구 대신: 경로에 «bad»가 있으면 실패로 답해요.
  on('tool.call', ($: any, e: any) => (String(e.file_path ?? '').includes('bad') ? { result: 'failed', isError: true } : { result: 'ok' }))
  on('classic.SessionStart', () => ({}))
  on('session.start', () => ({ cwd: '/work' }))
  return { clock, filled, runs, notes, kv }
}

async function start($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(0)
}

test('할 일 탭: Claude가 고친 파일이 최근 것부터 보이고, 같은 파일은 횟수로 합쳐요', async ($, on) => {
  const { clock, filled } = stub(on)
  await start($, clock)
  await $.tool.call({ tool: 'Write', file_path: '/work/docs/a.md', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/b.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/docs/a.md', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/bad.ts', old_string: 'x', new_string: 'y' }) // 실패는 안 올려요
  await $.tool.call({ tool: 'Read', file_path: '/work/c.md' }) // 읽기만 한 건 안 올려요
  await clock.advance(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /이번 대화에서 고친 파일/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^a\.md ×2  docs$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^b\.ts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bad\.ts/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /c\.md/ })).toBeUndefined()
  // «>» 를 누르면 왜 바꿨는지 묻는 글이 입력창에 들어가요
  await ui.press({ key: 'chg-0' })
  await clock.advance(0)
  expect(filled).toEqual(['이번 대화에서 /work/docs/a.md 파일을 왜, 어떻게 바꿨는지 쉽게 설명해 줘.'])
  await ui.unmount()
})

test('할 일 탭: /clear 하면 고친 파일 목록이 비어요', async ($, on) => {
  const { clock } = stub(on)
  await start($, clock)
  await $.tool.call({ tool: 'Write', file_path: '/work/a.md', content: 'x' })
  await $.classic.SessionStart({ source: 'clear' })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^a\.md/ })).toBeUndefined()
  await ui.unmount()
})

test('할 일 탭: 고친 파일 목록은 대화마다 저장돼서, 다시 불러와도 남아 있어요', async ($, on) => {
  const { clock, kv } = stub(on)
  await start($, clock)
  await $.tool.call({ tool: 'Write', file_path: '/work/a.md', content: 'x' })
  await clock.advance(0)
  const saved = kv.get('changes') as Record<string, { files: { path: string }[] }>
  expect(saved['abc12345-test']!.files.map(f => f.path)).toEqual(['/work/a.md'])
})

test('설정 탭: 처음 열면 한 번 점검해요. 버전·화면·Gmail·캘린더·클립보드 기록·알림', async ($, on) => {
  const { clock } = stub(on, { calendar: 'permission' })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'Claude Code 버전 · 2.1.300' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '화면 · 옆 창 · 마우스로 눌러요' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Gmail (메일 탭) · 연결됨' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '구글 캘린더 (일정) · 연결은 됐는데 읽는 권한을 아직 안 받았어요' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '→ /permissions 에서 mcp__claude_ai_Google_Calendar__list_events 허용' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '클립보드 기록 · 켜져 있어요' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '알림 · 윈도우 알림을 써요' })).toBeDefined()
  await ui.unmount()
})

test('설정 탭: 버전이 낮으면 ✗ 와 고치는 법', async ($, on) => {
  const { clock } = stub(on, { version: '2.1.250' })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /2\.1\.250 · 2\.1\.287 이상이 필요해요/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '→ 터미널에서 claude update' })).toBeDefined()
  await ui.unmount()
})

test('설정 탭: 입력창 위에 열려 있으면 화면 줄이 ✗ 이고 /tui fullscreen 을 알려 줘요', async ($, on) => {
  const { clock } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: '→ /tui fullscreen 을 한 번 치기' })).toBeDefined()
  await ui.unmount()
})

test('설정 탭: 점검은 처음 한 번만, 다시 하려면 «다시 점검»', async ($, on) => {
  const { clock, runs } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  const clipRuns = () => runs.filter(a => a.includes('-STA')).length
  expect(clipRuns()).toBe(1)
  await ui.press({ key: 'tab-pin' })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  expect(clipRuns()).toBe(1)
  await ui.press({ key: 'recheck' })
  await clock.advance(0)
  expect(clipRuns()).toBe(2)
  await ui.unmount()
})

test('명령 탭: 5번 탭이고, 누르면 입력창에 넣기만 하고 실행하지 않아요', async ($, on) => {
  const { clock, filled } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'tab-cmds' }))?.props.hotkey).toBe('5')
  expect((await ui.find({ key: 'tab-settings' }))?.props.hotkey).toBe('6')
  await ui.press({ key: 'tab-cmds' })
  await clock.advance(0)
  expect(await ui.find({ key: 'cmd-rewind' })).toBeDefined()
  await ui.press({ key: 'cmd-compact' })
  await ui.press({ key: 'cmd-tui-fullscreen' })
  await ui.press({ key: 'cmd-reload-plugins' })
  await clock.advance(0)
  expect(filled).toEqual(['/compact', '/tui fullscreen', '/reload-plugins'])
  // 설정 탭에는 이제 명령 목록이 없어요
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ key: 'cmd-compact' })).toBeUndefined()
  await ui.unmount()
})

test('명령 탭: × 로 빼면 목록에서 사라지고, 다음에 열어도 빠져 있어요', async ($, on) => {
  const { clock, kv } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-cmds' })
  await ui.press({ key: 'del-cmd-doctor' })
  await clock.advance(0)
  expect(await ui.find({ key: 'cmd-doctor' })).toBeUndefined()
  expect(kv.get('cmdHidden')).toEqual(['/doctor'])
  await ui.unmount()
})

test('명령 탭: 칸에 «/명령 설명»을 쓰고 엔터를 누르면 목록 끝에 들어가요', async ($, on) => {
  const { clock, kv, filled } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-cmds' })
  await ui.input({ key: 'cmd-add-0', text: '/capcut 릴스 편집', kind: 'submit' })
  await clock.advance(0)
  expect(await ui.find({ key: 'cmd-capcut' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '릴스 편집' })).toBeDefined()
  expect(kv.get('cmdAdded')).toEqual([{ name: 'capcut', text: '릴스 편집' }])
  // 넣고 나면 빈 칸을 새로 그려요
  expect(await ui.find({ key: 'cmd-add-1' })).toBeDefined()
  await ui.press({ key: 'cmd-capcut' })
  await clock.advance(0)
  expect(filled).toEqual(['/capcut'])
  // 넣은 것도 × 로 빼요
  await ui.press({ key: 'del-cmd-capcut' })
  await clock.advance(0)
  expect(await ui.find({ key: 'cmd-capcut' })).toBeUndefined()
  expect(kv.get('cmdAdded')).toEqual([])
  await ui.unmount()
})

test('명령 탭: 잘못 쓰거나 이미 있는 명령이면 넣지 않고 이유를 보여 줘요', async ($, on) => {
  const { clock, kv } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-cmds' })
  await ui.input({ key: 'cmd-add-0', text: '/한글 명령', kind: 'submit' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /명령 이름으로 쓸 수 없어요/ })).toBeDefined()
  await ui.input({ key: 'cmd-add-0', text: '/compact 다른 설명', kind: 'submit' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /\/compact 는 이미 목록에 있어요/ })).toBeDefined()
  expect(kv.get('cmdAdded')).toBeUndefined()
  await ui.unmount()
})

test('명령 탭: 뺐던 기본 명령을 다시 쓰면 돌아오고, «처음 목록으로»는 바꾼 걸 다 되돌려요', async ($, on) => {
  const { clock, kv } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-cmds' })
  expect(await ui.find({ key: 'cmd-reset' })).toBeUndefined()
  await ui.press({ key: 'del-cmd-help' })
  await clock.advance(0)
  await ui.input({ key: 'cmd-add-0', text: 'help', kind: 'submit' })
  await clock.advance(0)
  expect(await ui.find({ key: 'cmd-help' })).toBeDefined()
  expect(kv.get('cmdHidden')).toEqual([])
  await ui.press({ key: 'del-cmd-model' })
  await ui.input({ key: 'cmd-add-1', text: '/capcut', kind: 'submit' })
  await clock.advance(0)
  await ui.press({ key: 'cmd-reset' })
  await clock.advance(0)
  expect(await ui.find({ key: 'cmd-model' })).toBeDefined()
  expect(await ui.find({ key: 'cmd-capcut' })).toBeUndefined()
  expect(kv.get('cmdAdded')).toEqual([])
  expect(kv.get('cmdHidden')).toEqual([])
  await ui.unmount()
})

test('명령 탭: 저장해 둔 목록을 세션을 시작할 때 읽어요', async ($, on) => {
  const { clock, kv } = stub(on)
  kv.set('cmdAdded', [{ name: 'capcut', text: '릴스 편집' }])
  kv.set('cmdHidden', ['/clear'])
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-cmds' })
  expect(await ui.find({ key: 'cmd-capcut' })).toBeDefined()
  expect(await ui.find({ key: 'cmd-clear' })).toBeUndefined()
  await ui.unmount()
})

test('설정 탭: «알림 시험»은 알림을 꺼 둬도 한 번 띄워요', async ($, on) => {
  const { clock, runs } = stub(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  await ui.press({ key: 'toggle-notify' }) // 끄기
  await ui.press({ key: 'notify-test' })
  await clock.advance(0)
  expect(runs.some(a => a[0] === 'powershell' && a.join(' ').includes('알림 시험'))).toBe(true)
  await ui.unmount()
})

test('맥·리눅스: 클립보드 기록은 «해당 없음», 알림 시험은 터미널 알림으로 가요', async ($, on) => {
  const { clock, notes, runs } = stub(on, { env: {} })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: '클립보드 기록 · 윈도우에서만 써요' })).toBeDefined()
  await ui.press({ key: 'notify-test' })
  await clock.advance(0)
  expect(notes).toEqual([{ text: '이 알림이 보이면 잘 돼요', title: '알림 시험' }])
  expect(runs.length).toBe(0)
  await ui.unmount()
})
