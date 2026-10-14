import { expect, test } from 'claude-code/testing'
import { AUTO_DECISION_ID, findTaskId, mirrorTool, trailingQuestion, withAutoDecision } from '../hooks/mirror.ts'

const EMPTY = { todos: [], decisions: [] }

test('TodoWrite: 목록 전체를 그대로 옮겨요', async () => {
  const b = mirrorTool(EMPTY, 'TodoWrite', {
    todos: [
      { content: '자료 조사', status: 'completed', activeForm: '자료 조사 중' },
      { content: '초안 쓰기', status: 'in_progress', activeForm: '초안 쓰는 중' },
      { content: '검토', status: 'pending', activeForm: '검토 중' },
    ],
  }, undefined)
  expect(b!.todos.map(t => t.text)).toEqual(['자료 조사', '초안 쓰기', '검토'])
  expect(b!.todos[0]!.isDone).toBe(true)
  expect(b!.todos[1]!.isActive).toBe(true)
  expect(b!.todos[2]!.isDone).toBe(false)
  // 다시 보내면 통째로 바뀌어요
  const b2 = mirrorTool(b!, 'TodoWrite', { todos: [{ content: '검토', status: 'completed', activeForm: '' }] }, undefined)
  expect(b2!.todos.length).toBe(1)
})

test('TaskCreate·TaskUpdate: 하나씩 만들고 상태를 바꿔요', async () => {
  let b = mirrorTool(EMPTY, 'TaskCreate', { subject: '자료 조사', description: '' }, { task: { id: '7', subject: '자료 조사' } })!
  b = mirrorTool(b, 'TaskCreate', { subject: '초안 쓰기', description: '' }, { task: { id: '8', subject: '초안 쓰기' } })!
  expect(b.todos.map(t => t.ref)).toEqual(['7', '8'])
  b = mirrorTool(b, 'TaskUpdate', { taskId: '7', status: 'in_progress' }, undefined)!
  expect(b.todos[0]!.isActive).toBe(true)
  b = mirrorTool(b, 'TaskUpdate', { taskId: '8', status: 'in_progress' }, undefined)!
  expect(b.todos[0]!.isActive).toBe(false) // 진행 중인 건 하나만
  expect(b.todos[1]!.isActive).toBe(true)
  b = mirrorTool(b, 'TaskUpdate', { taskId: '8', status: 'completed' }, undefined)!
  expect(b.todos[1]!.isDone).toBe(true)
  b = mirrorTool(b, 'TaskUpdate', { taskId: '7', status: 'deleted' }, undefined)!
  expect(b.todos.length).toBe(1)
})

test('TaskCreate: 결과에서 번호를 못 읽어도 만든 순서를 번호로 써요', async () => {
  let b = mirrorTool(EMPTY, 'TaskCreate', { subject: '하나' }, { text: '만들었어요' })!
  b = mirrorTool(b, 'TaskCreate', { subject: '둘' }, { text: '만들었어요' })!
  expect(b.todos.map(t => t.ref)).toEqual(['1', '2'])
  const u = mirrorTool(b, 'TaskUpdate', { taskId: '2', status: 'completed' }, undefined)!
  expect(u.todos[1]!.isDone).toBe(true)
})

test('모르는 도구나 못 찾는 번호는 바꾸지 않아요', async () => {
  expect(mirrorTool(EMPTY, 'Bash', { command: 'ls' }, undefined)).toBe(undefined)
  expect(mirrorTool(EMPTY, 'TaskUpdate', { taskId: '99', status: 'completed' }, undefined)).toBe(undefined)
  expect(mirrorTool(EMPTY, 'TaskCreate', { subject: '   ' }, undefined)).toBe(undefined)
})

test('결과에서 번호 찾기', async () => {
  expect(findTaskId({ task: { id: '12', subject: 'x' } })).toBe('12')
  expect(findTaskId('Task #5 created successfully')).toBe('5')
  expect(findTaskId({ text: '없음' })).toBe(undefined)
})

test('답변 끝의 질문을 «결정 대기»로 뽑아요', async () => {
  expect(trailingQuestion('정리했어요.\n\n이어서 표도 만들까요?')).toBe('이어서 표도 만들까요?')
  expect(trailingQuestion('두 가지가 있어요.\n- A안\n- B안\n어느 쪽으로 할지 골라 주세요.')).toBe('어느 쪽으로 할지 골라 주세요.')
  expect(trailingQuestion('끝났어요.')).toBe(undefined)
  // 코드 블록 안의 물음표는 질문이 아니에요
  expect(trailingQuestion('이렇게 하면 돼요.\n```\nwhere x = ?\n```\n끝.')).toBe(undefined)
  const long = '가'.repeat(300) + '?'
  expect(trailingQuestion(long)!.length).toBeLessThanOrEqual(200)
})

test('실제 답변처럼 요청이 끝줄 앞에 있어도 뽑아요', async () => {
  const real = [
    '**남은 것 (공개 전)**',
    '- 비공개 저장소를 만들어 올리는 일은 아직 안 했어요. 승인해 주신 뒤에 해요.',
    '- OWNER(GitHub 계정·저장소 이름)를 정해 주세요.',
    '- 오늘 고친 두 가지는 실제 화면에서 확인하지 못했어요.',
    '',
    '한 번 봐 주세요.',
    '',
    '공개 일정은 위 세 가지를 정해 주시면 이어서 할게요.',
  ].join('\n')
  const q = trailingQuestion(real)!
  expect(q).toContain('정해 주세요')
  expect(q).toContain('봐 주세요')
  expect(q).toContain('정해 주시면')
  // 서술만 한 답변은 그대로 비워 둬요
  expect(trailingQuestion('파일을 고쳤어요.\n테스트 75개가 통과했어요.\n끝났어요.')).toBe(undefined)
})

test('자동 결정 항목은 내가 직접 올린 결정을 건드리지 않아요', async () => {
  const b = { todos: [], decisions: [{ id: 'd1', text: '직접 올린 것' }] }
  const withQ = withAutoDecision(b, '이어서 할까요?')
  expect(withQ.decisions.map(d => d.id)).toEqual(['d1', AUTO_DECISION_ID])
  const cleared = withAutoDecision(withQ, undefined)
  expect(cleared.decisions.map(d => d.id)).toEqual(['d1'])
})
