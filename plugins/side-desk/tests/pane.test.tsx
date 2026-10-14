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

test('이어가기 탭: 버튼이 그려져요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-handoff' })
  expect(await ui.find({ key: 'handoff-now' })).toBeDefined()
  expect(await ui.find({ key: 'handoff-mode' })).toBeDefined()
  await ui.unmount()
})

test('설정 탭: 스위치 세 개가 있고 눌려요', async ($, on) => {
  const { clock, stored } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ key: 'toggle-send' })).toBeDefined()
  expect(await ui.find({ key: 'toggle-notify' })).toBeDefined()
  expect(await ui.find({ key: 'toggle-coach' })).toBeDefined()
  await ui.press({ key: 'toggle-send' })
  expect(stored.get('sendConfirm')).toBe(false)
  await ui.unmount()
})

test('데스크톱 앱에서도 다섯 탭이 그려져요', async ($, on) => {
  const { clock } = stubSession(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const key of ['tab-usage', 'tab-handoff', 'tab-settings', 'tab-pin']) await ui.press({ key })
  expect(await ui.find({ type: 'Text', text: /내가 정해야 하는 것/ })).toBeDefined()
  await ui.unmount()
})
