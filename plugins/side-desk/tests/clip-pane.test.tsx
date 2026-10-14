import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'side-desk',
  component: 'Pane',
  requestId: 'side-desk',
  viewport: { columns: 100, rows: 30 },
  props: { title: '책상', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const USAGE = { startedAt: 0, rateLimits: [], cost: null, context: { tokens: 1000, window: 1_000_000, percent: 0.1 } }

const listText = (items: Record<string, unknown>[]) => 'BEGIN\n' + items.map(o => JSON.stringify(o)).join('\n') + (items.length ? '\n' : '') + 'END\n'

// 클립보드 탭에 필요한 것만 답해 주는 가짜 환경.
//  · process.spawn  = 감시 프로세스(한 번만). state.pending 에 목록을 넣고 시간을 돌리면 내보내요.
//  · process.run    = 항목 하나의 전체 내용, 지금 클립보드, «새로 읽기» 한 번.
function stubClip(on: any) {
  const clock = mock.clock(on)
  const filled: string[] = []
  const state = {
    list: [] as Record<string, unknown>[],
    pending: undefined as Record<string, unknown>[] | undefined,
    itemText: {} as Record<string, string>,
    runs: [] as string[],
    spawns: 0,
    killed: 0,
    shown: true,
    ticks: 0, // 감시가 받을 TICK 개수
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
  on('ui.panes', () => ({ value: [{ id: 'side-desk', title: '책상', isShown: state.shown, isFocused: false, isPlaced: true }] }))
  on('prompt.fill', ($: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('process.run', ($: any, e: any) => {
    const script: string = e.argv[e.argv.length - 1] ?? ''
    let stdout = ''
    if (script.includes('ConvertTo-Json')) {
      state.runs.push('list')
      stdout = state.list.map(o => JSON.stringify(o)).join('\n') + '\n'
    } else if (script.includes('$found')) {
      const id = /-eq '(\d+)'/.exec(script)?.[1] ?? ''
      state.runs.push('item:' + id)
      stdout = state.itemText[id] !== undefined ? 'TEXT\n' + state.itemText[id] + '\n' : 'EMPTY\n'
    } else if (script.includes('ContainsImage')) {
      state.runs.push('current')
      stdout = 'TEXT\n현재 글\n'
    }
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  // 감시 프로세스: 처음 목록을 내보내고, 1초마다 새 목록(pending)이 있으면 내보내고, 10초마다 TICK 을 보내요.
  on('process.spawn', async function* () {
    state.spawns++
    try {
      yield { stream: 'stdout', text: listText(state.list) }
      for (let i = 1; i <= 120; i++) {
        await clock.sleep(1000)
        if (state.pending) {
          yield { stream: 'stdout', text: listText(state.pending) }
          state.pending = undefined
        }
        if (i % 10 === 0) {
          state.ticks++
          yield { stream: 'stdout', text: 'TICK\n' }
        }
      }
      return { code: 0, signal: null }
    } finally {
      state.killed++
    }
  })
  on('session.start', () => ({ cwd: '/work' }))
  return { clock, filled, state }
}

async function open($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

const ITEMS = [
  { id: '200', at: '13:57:00', kind: 'text', chars: 11, preview: '최신 글 앞부분' },
  { id: '150', at: '13:56:10', kind: 'image' },
  { id: '100', at: '13:50:00', kind: 'text', chars: 7, preview: '이전 글' },
]

test('클립 탭: 윈도우 클립보드 기록이 목록으로 보여요', async ($, on) => {
  const { clock, state } = stubClip(on)
  state.list = ITEMS
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /최신 글 앞부분/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /13:56 이미지/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /이전 글/ })).toBeDefined()
  await ui.unmount()
})

test('클립 탭: 줄을 누르면 그 항목의 전체 내용이 입력창에 들어가요', async ($, on) => {
  const { clock, filled, state } = stubClip(on)
  state.list = ITEMS
  state.itemText = { '200': '최신 글 전체\n둘째 줄', '100': '이전 글 전체' }
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  await ui.press({ key: 'clip-item-100' })
  await clock.advance(0)
  expect(filled).toEqual(['이전 글 전체'])
  expect(state.runs).toContain('item:100')
  await ui.unmount()
})

test('클립 탭: «최신 것 붙이기»는 맨 위 항목을 붙여요', async ($, on) => {
  const { clock, filled, state } = stubClip(on)
  state.list = ITEMS
  state.itemText = { '200': '최신 글 전체' }
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  await ui.press({ key: 'clip-paste' })
  await clock.advance(0)
  expect(filled).toEqual(['최신 글 전체'])
  await ui.unmount()
})

test('프로세스를 계속 새로 만들지 않아요: 감시는 한 번, 새 복사는 그 출력으로 와요', async ($, on) => {
  const { clock, state } = stubClip(on)
  state.list = ITEMS
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /방금 복사한 글/ })).toBeUndefined()
  // 사용자가 새로 복사한 상황: 감시 프로세스가 새 목록을 내보내요
  state.pending = [{ id: '300', at: '13:59:00', kind: 'text', chars: 9, preview: '방금 복사한 글' }, ...ITEMS]
  await clock.advance(1500)
  expect(await ui.find({ type: 'Text', text: /방금 복사한 글/ })).toBeDefined()
  // 그동안 프로세스는 한 번만 띄웠고, 목록을 읽으려고 새로 띄운 것은 없어요
  expect(state.spawns).toBe(1)
  expect(state.runs.filter(r => r === 'list').length).toBe(0)
  await ui.unmount()
})

test('다른 탭을 보는 동안에는 아무 프로세스도 띄우지 않아요', async ($, on) => {
  const { clock, state } = stubClip(on)
  state.list = ITEMS
  await open($, clock)
  await clock.advance(30_000)
  expect(state.spawns).toBe(0)
  expect(state.runs.length).toBe(0)
})

test('옆 창을 안 보면 1분 뒤 감시를 끝내고, 프로세스도 같이 끝나요', async ($, on) => {
  const { clock, state } = stubClip(on)
  state.list = ITEMS
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  expect(state.spawns).toBe(1)
  state.shown = false // 옆 창을 닫았어요
  await clock.advance(70_000)
  expect(state.killed).toBe(1)
  await ui.unmount()
})

test('보고 있는 동안에는 오래 가만히 둬도 감시가 끊기지 않아요', async ($, on) => {
  const { clock, state } = stubClip(on)
  state.list = ITEMS
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  await clock.advance(100_000)
  expect(state.killed).toBe(0)
  await ui.unmount()
})

test('클립 탭: 기록을 못 읽으면 지금 클립보드 한 개라도 보여요', async ($, on) => {
  const { clock, state } = stubClip(on)
  state.list = [] // 감시가 빈 목록을 줘요(기록 꺼짐)
  const ui = await open($, clock)
  await ui.press({ key: 'tab-clip' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /현재 글/ })).toBeDefined()
  expect(state.runs).toContain('current')
  await ui.unmount()
})
