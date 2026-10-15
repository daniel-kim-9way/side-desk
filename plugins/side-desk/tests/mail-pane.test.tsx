import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'side-desk',
  component: 'Pane',
  requestId: 'side-desk',
  viewport: { columns: 100, rows: 30 },
  props: { title: '책상', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const USAGE = { startedAt: 0, rateLimits: [], cost: null, context: { tokens: 1000, window: 1_000_000, percent: 0.1 } }
const URL1 = 'https://mail.google.com/mail/?authuser=me@example.com#all/thread-f:1|msg-f:1'

// search_threads 가 돌려주는 모양 그대로(필드 이름은 실제 응답에서 옮겼어요)
const LIST = {
  threads: [
    {
      id: 't1',
      messageCount: 1,
      viewUrl: URL1,
      messages: [{ id: 'm1', date: '2026-10-15T02:23:39Z', sender: 'workspace-noreply@google.com', subject: '보안 알림', labelIds: ['UNREAD', 'INBOX'], snippet: '앞부분' }],
    },
    {
      id: 't2',
      messageCount: 2,
      viewUrl: URL1,
      messages: [
        { id: 'm2', date: '2026-10-13T01:00:00Z', sender: '홍길동 <hong@example.com>', subject: '견적 문의', labelIds: ['INBOX'] },
        { id: 'm3', date: '2026-10-14T01:00:00Z', sender: 'me@example.com', subject: 'Re: 견적 문의', labelIds: ['INBOX'] },
      ],
    },
  ],
}

const THREAD_T2 = {
  id: 't2',
  viewUrl: URL1,
  messages: [
    { id: 'm2', date: '2026-10-13T01:00:00Z', sender: '홍길동 <hong@example.com>', subject: '견적 문의', plaintextBody: '처음 보낸 본문' },
    { id: 'm3', date: '2026-10-14T01:00:00Z', sender: 'me@example.com', subject: 'Re: 견적 문의', plaintextBody: '답장 본문\n\n\n\n둘째 단락' },
  ],
}

const ok = (o: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(o) }], isError: false } })

// 메일 탭에 필요한 것만 답해 주는 가짜 환경.
//  · mcp.call   = Gmail 커넥터. state.mode 로 연결됨·안 됨·오류 답을 고르고, 부른 도구를 calls 에 남겨요.
//  · command.run = «연결하기»가 여는 /mcp
function stubMail(on: any) {
  const clock = mock.clock(on)
  const filled: { text: string; mode?: string }[] = []
  const state = {
    mode: 'connected' as 'connected' | 'throws' | 'isError' | 'permission',
    calls: [] as { server: string; tool: string; args: Record<string, unknown> }[],
    commands: [] as string[],
    runs: [] as string[],
    shown: true, // 옆 창이 화면에 보이는지
  }
  on('env.get', ($: any, e: any) => ({ value: (e.name ?? e.key) === 'OS' ? 'Windows_NT' : undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'abc12345-test' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '{"tasks":[]}' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.panes', () => ({ value: [{ id: 'side-desk', title: '책상', isShown: state.shown, isFocused: false, isPlaced: true }] }))
  on('prompt.fill', ($: any, e: any) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('process.run', ($: any, e: any) => {
    state.runs.push(String(e.argv[e.argv.length - 1] ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('command.run', ($: any, e: any) => {
    state.commands.push(e.command)
    return {}
  })
  on('mcp.call', ($: any, e: any) => {
    state.calls.push({ server: e.server, tool: e.tool, args: e.args })
    // { deny } 는 부른 쪽의 promise 를 거절해요(연결 안 된 서버를 부른 것과 같아요)
    if (state.mode === 'throws') return { deny: 'MCP server "claude.ai Gmail" is not connected' }
    // 실제 엔진이 권한 묻기를 건너뛰지 않는 세션에서 낸 문장 그대로예요(claude -p 로 확인)
    if (state.mode === 'permission') return { deny: `$.mcp.call(claude.ai Gmail, search_threads) refused: Claude requested permissions to use mcp__claude_ai_Gmail__search_threads, but you haven't granted it yet.` }
    if (state.mode === 'isError') return { value: { content: [{ type: 'text', text: 'Authentication required' }], isError: true } }
    if (e.tool === 'search_threads') return ok(LIST)
    if (e.tool === 'get_thread') return ok(e.args.threadId === 't2' ? THREAD_T2 : { id: e.args.threadId, messages: [] })
    return ok({})
  })
  on('session.start', () => ({ cwd: '/work' }))
  return { clock, filled, state }
}

async function open($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('메일 탭을 열기 전에는 Gmail 을 부르지 않아요', async ($, on) => {
  const { clock, state } = stubMail(on)
  await open($, clock)
  await clock.advance(120_000)
  expect(state.calls.length).toBe(0)
})

test('메일 탭: 받은편지함 제목만 보여 주고, 연결된 계정을 적어요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(state.calls.map(c => c.tool)).toEqual(['search_threads'])
  expect(state.calls[0]!.server).toBe('claude.ai Gmail')
  expect(state.calls[0]!.args.query).toBe('in:inbox')
  expect(await ui.find({ type: 'Text', text: /보안 알림/ })).toBeDefined()
  // 여러 통짜리는 첫 메일 제목에 통 수를 붙여요
  expect(await ui.find({ type: 'Text', text: /견적 문의 \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /me@example\.com/ })).toBeDefined()
  // 목록에는 본문 앞부분을 보여 주지 않아요
  expect(await ui.find({ type: 'Text', text: /앞부분/ })).toBeUndefined()
  await ui.unmount()
})

test('메일 탭: 줄을 누르면 그때 본문을 불러와요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  await ui.press({ key: 'mail-t2' })
  await clock.advance(0)
  const get = state.calls.find(c => c.tool === 'get_thread')
  expect(get?.args.threadId).toBe('t2')
  expect(get?.args.messageFormat).toBe('PLAIN_TEXT')
  // 최신 메일이 위, 빈 줄 여러 개는 하나로 줄여요
  expect(await ui.find({ type: 'Text', text: '답장 본문\n\n둘째 단락' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /처음 보낸 본문/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2통 · 최신부터/ })).toBeDefined()
  // 목록으로 돌아가요
  await ui.press({ key: 'mail-back' })
  expect(await ui.find({ type: 'Text', text: /보안 알림/ })).toBeDefined()
  await ui.unmount()
})

test('메일 탭: 목록의 «>»는 본문을 열지 않고 «조치사항 찾기» 글로 입력창을 채워요', async ($, on) => {
  const { clock, filled, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  await ui.press({ key: 'mail-ask-t2' })
  await clock.advance(0)
  expect(filled.length).toBe(1)
  // 입력창을 통째로 채워요(mode 를 따로 주지 않으면 엔진이 replace 로 채워요)
  expect(filled[0]!.mode).toBe('replace')
  expect(filled[0]!.text).toBe('메일 「견적 문의」(me@example.com, 2026-10-14, Gmail 스레드 t2)을 Gmail에서 읽고 내용을 확인한 뒤, 내가 해야 할 조치사항을 찾아 줘.')
  // 본문은 Claude 가 스레드 번호로 읽어요. 모드는 본문을 부르지 않았어요.
  expect(state.calls.map(c => c.tool)).toEqual(['search_threads'])
  await ui.unmount()
})

test('메일 탭: 펼친 메일의 «> 조치사항 찾기»도 같은 글을 넣어요', async ($, on) => {
  const { clock, filled } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  await ui.press({ key: 'mail-t2' })
  await clock.advance(0)
  await ui.press({ key: 'mail-ask' })
  await clock.advance(0)
  expect(filled[0]!.text).toContain('「견적 문의」')
  expect(filled[0]!.text).toContain('Gmail 스레드 t2')
  expect(filled[0]!.text).toContain('조치사항을 찾아 줘')
  await ui.unmount()
})

test('메일 탭: 목록의 «↗»와 펼친 메일의 «↗ Gmail»은 Gmail 주소만 브라우저로 넘겨요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  await ui.press({ key: 'mail-web-t1' })
  await clock.advance(0)
  expect(state.runs).toEqual([`Start-Process '${URL1}'`])
  await ui.press({ key: 'mail-t2' })
  await clock.advance(0)
  await ui.press({ key: 'mail-browser' })
  await clock.advance(0)
  expect(state.runs.length).toBe(2)
  await ui.unmount()
})

test('연결이 안 돼 있으면 «연결하기»가 보이고, 누르면 /mcp 를 열어요', async ($, on) => {
  const { clock, state } = stubMail(on)
  state.mode = 'throws'
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(await ui.find({ key: 'mail-connect' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not connected/ })).toBeDefined()
  await ui.press({ key: 'mail-connect' })
  await clock.advance(0)
  expect(state.commands).toEqual(['mcp'])
  // 연결한 뒤 «다시 시도»를 누르면 목록이 떠요
  state.mode = 'connected'
  await ui.press({ key: 'mail-refresh' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /보안 알림/ })).toBeDefined()
  expect(await ui.find({ key: 'mail-connect' })).toBeUndefined()
  await ui.unmount()
})

test('로그인이 풀려 오류로 답해도 «연결하기»가 보여요', async ($, on) => {
  const { clock, state } = stubMail(on)
  state.mode = 'isError'
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(await ui.find({ key: 'mail-connect' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Authentication required/ })).toBeDefined()
  await ui.unmount()
})

test('메일 탭을 다시 열어도 2분 안이면 다시 부르지 않아요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  await ui.press({ key: 'tab-pin' })
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(state.calls.length).toBe(1)
  await clock.advance(150_000)
  await ui.press({ key: 'tab-pin' })
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(state.calls.length).toBe(2)
  await ui.unmount()
})

test('권한을 안 받았으면 «연결하기» 대신 권한 안내가 보여요', async ($, on) => {
  const { clock, state } = stubMail(on)
  state.mode = 'permission'
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(await ui.find({ key: 'mail-connect' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /권한을 아직 안 받았어요/ })).toBeDefined()
  expect(await ui.find({ key: 'mail-refresh' })).toBeDefined()
  await ui.unmount()
})

test('메일 탭을 보고 있으면 5분마다 저절로 다시 읽고, 다른 탭이면 부르지 않아요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  expect(state.calls.length).toBe(1)
  await clock.advance(4 * 60_000)
  expect(state.calls.length).toBe(1)
  await clock.advance(2 * 60_000)
  expect(state.calls.length).toBe(2)
  await ui.press({ key: 'tab-pin' })
  await clock.advance(10 * 60_000)
  expect(state.calls.length).toBe(2)
  await ui.unmount()
})

test('옆 창이 안 보이면 메일 탭이 선택돼 있어도 저절로 부르지 않아요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  state.shown = false
  await clock.advance(10 * 60_000)
  expect(state.calls.length).toBe(1)
  await ui.unmount()
})

test('저절로 다시 읽다 실패하면 오류 화면으로 바꾸지 않고 보던 목록을 그대로 둬요', async ($, on) => {
  const { clock, state } = stubMail(on)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-mail' })
  await clock.advance(0)
  state.mode = 'isError'
  await clock.advance(6 * 60_000)
  expect(state.calls.length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /보안 알림/ })).toBeDefined()
  expect(await ui.find({ key: 'mail-connect' })).toBeUndefined()
  // 다음 5분에 또 시도해요
  state.mode = 'connected'
  await clock.advance(6 * 60_000)
  expect(state.calls.length).toBe(3)
  await ui.unmount()
})
