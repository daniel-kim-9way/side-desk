import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'side-desk',
  component: 'Pane',
  requestId: 'side-desk',
  viewport: { columns: 100, rows: 30 },
  props: { title: '책상', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const USAGE = { startedAt: 0, rateLimits: [], cost: null, context: { tokens: 1000, window: 1_000_000, percent: 0.1 } }

function stubPin(on: any) {
  const clock = mock.clock(on)
  const kv = new Map<string, unknown>()
  on('env.get', ($: any, e: any) => ({ value: (e.name ?? e.key) === 'OS' ? 'Windows_NT' : undefined }))
  on('store.get', ($: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'abc12345-test' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '{"tasks":[]}' }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  // 엔진이 대신 «실행»하는 도구들: 어떤 도구든 성공으로 답해요.
  on('tool.call', () => ({ result: 'ok' }))
  return { clock, kv }
}

async function open($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('핀: Claude가 평소 쓰는 TodoWrite 호출이 «이번 대화 할 일»에 그대로 보여요', async ($, on) => {
  const { clock } = stubPin(on)
  const ui = await open($, clock)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '보고서 초안 쓰기', status: 'in_progress', activeForm: '쓰는 중' },
      { content: '표 만들기', status: 'pending', activeForm: '만드는 중' },
    ],
  })
  expect(await ui.find({ type: 'Text', text: /보고서 초안 쓰기/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /표 만들기/ })).toBeDefined()
  await ui.unmount()
})

test('핀: TaskCreate·TaskUpdate 도 따라가요', async ($, on) => {
  const { clock } = stubPin(on)
  const ui = await open($, clock)
  await $.tool.call({ tool: 'TaskCreate', subject: '자료 조사', description: '' })
  expect(await ui.find({ type: 'Text', text: /자료 조사/ })).toBeDefined()
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  expect(await ui.find({ type: 'Text', text: /1개 끝/ })).toBeDefined()
  await ui.unmount()
})

test('핀: 답변이 질문으로 끝나면 «결정을 기다리는 것»에 오르고, 내가 말하면 내려가요', async ($, on) => {
  const { clock } = stubPin(on)
  const ui = await open($, clock)
  await $.turn.complete({ turnId: 't1', answer: '표를 만들었어요.\n\n이어서 그래프도 넣을까요?', durationMs: 1000, isAborted: false, usage: null })
  expect(await ui.find({ type: 'Text', text: /그래프도 넣을까요/ })).toBeDefined()
  // 사람이 다음 말을 보내면 내려가요
  await $.prompt.submit({ text: '네 넣어 줘', origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: /그래프도 넣을까요/ })).toBeUndefined()
  await ui.unmount()
})

test('핀: 질문으로 끝나지 않은 답변은 아무것도 올리지 않아요', async ($, on) => {
  const { clock } = stubPin(on)
  const ui = await open($, clock)
  await $.turn.complete({ turnId: 't2', answer: '다 했어요.', durationMs: 1000, isAborted: false, usage: null })
  expect(await ui.find({ type: 'Text', text: /없음/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /다 했어요/ })).toBeUndefined()
  await ui.unmount()
})
