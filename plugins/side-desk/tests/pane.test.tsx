import { expect, mock, test } from 'claude-code/testing'

// Claude Code가 이 옆 창을 그릴 때 ui.render 훅에 넘기는 값
const PANE = {
  plugin: 'side-desk',
  component: 'Pane',
  requestId: 'side-desk',
  viewport: { columns: 100, rows: 30 },
  props: { title: '책상', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const USAGE = {
  startedAt: 0,
  rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: '1970-01-01T02:00:00Z' }],
  cost: { usd: 1.2 },
  context: { tokens: 50_000, window: 1_000_000, percent: 5 },
}

function stubSession(on: any) {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  on('env.get', ($: any, e: any) => ({ value: (e.name ?? e.key) === 'OS' ? 'Windows_NT' : undefined }))
  on('store.get', ($: any, e: any) => ({ value: stored.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'abc12345-test' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  return { clock, stored }
}

async function start($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(0)
}

test('핀 탭: Claude가 쌓은 할 일과 결정이 보여요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  await $.tool.call({ tool: 'mcp__side-desk__pin', add_todos: ['보고서 초안 쓰기', '표 만들기'], open_decisions: ['제목을 어느 쪽으로 할까요?'] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /보고서 초안 쓰기/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /제목을 어느 쪽으로/ })).toBeDefined()
  await ui.unmount()
})

test('사용 탭: 비용과 한도가 그려져요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-usage' })
  expect(await ui.find({ type: 'Text', text: '$1.20' })).toBeDefined()
  await ui.unmount()
})

test('사용량 탭: 이어가기도 같은 탭에 있어요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-usage' })
  // 이어가기 탭은 사용량 탭으로 합쳤어요. 그 자리에는 메일 탭이 들어갔어요.
  expect(await ui.find({ key: 'tab-handoff' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-mail' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /새 대화로 이어가기/ })).toBeDefined()
  expect(await ui.find({ key: 'handoff-now' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-mode' })).toBeDefined()
  await ui.unmount()
})

test('설정 탭: 스위치 네 개가 있고 눌려요', async ($, on) => {
  const { clock, stored } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ key: 'toggle-send' })).toBeDefined()
  expect(await ui.find({ key: 'toggle-notify' })).toBeDefined()
  expect(await ui.find({ key: 'toggle-coach' })).toBeDefined()
  await ui.press({ key: 'toggle-send' })
  expect(stored.get('sendConfirm')).toBe(false)
  // 알림은 «질문·승인»과 «작업 끝» 두 스위치예요. 작업 끝 알림은 기본으로 꺼져 있어요.
  expect(await ui.find({ type: 'Text', text: /질문·승인 알림 켜짐/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /작업 끝 알림 꺼짐/ })).toBeDefined()
  await ui.press({ key: 'toggle-notify-done' })
  expect(stored.get('notifyDone')).toBe(true)
  await ui.unmount()
})

test('데스크톱 앱에서도 다섯 탭이 그려져요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const key of ['tab-usage', 'tab-mail', 'tab-clip', 'tab-settings', 'tab-pin']) await ui.press({ key })
  expect(await ui.find({ type: 'Text', text: /내가 정해야 하는 것/ })).toBeDefined()
  await ui.unmount()
})

test('소제목은 굵게 + 밑줄이고, 옆의 작은 글은 밑줄 없이 흐려요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-usage' })
  for (const title of ['사용 한도', '대화 길이', '새 대화로 이어가기', '이 대화']) {
    // 바깥 Text(자르기 담당)와 안쪽 Text(굵게·밑줄)가 같은 글을 가져요. 안쪽 것을 봐요.
    const found = await ui.findAll({ type: 'Text', text: title })
    expect(found.some(t => t.props.bold === true && t.props.underline === true)).toBe(true)
  }
  const side = await ui.findAll({ type: 'Text', text: /가득 차면 앞부분을 잊어요/ })
  expect(side.some(t => t.props.dimColor === true && t.props.underline !== true)).toBe(true)
  expect(side.some(t => t.props.underline === true)).toBe(false)
  await ui.unmount()
})

test('창 너비에 맞춰 탭 이름을 줄여서 탭 줄이 한 줄에 들어가요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const label = async (bodyColumns: number, key: string) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
    const found = await ui.find({ key })
    await ui.unmount()
    return found?.props.label
  }
  // 넓으면 원래 이름
  expect(await label(60, 'tab-clip')).toBe('클립보드')
  expect(await label(60, 'tab-usage')).toBe('사용량')
  // 44칸: «클립보드»만 «클립»으로
  expect(await label(44, 'tab-clip')).toBe('클립')
  expect(await label(44, 'tab-usage')).toBe('사용량')
  // 40칸(옆 창 기본 너비): 가장 짧은 이름
  expect(await label(40, 'tab-usage')).toBe('한도')
  expect(await label(40, 'tab-pin')).toBe('할일')
})
