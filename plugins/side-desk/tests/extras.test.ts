import { expect, test } from 'claude-code/testing'
import {
  addChange, calendarArgs, changeLabel, changePrompt, changesFromMessages, COMMAND_GUIDE, connectorCheck, effectiveGuide, eventEnded, eventTime,
  guideCommand, guideKey, isDefaultGuide, localMidnight, parseEvents, parseGuideInput, permissionNote, versionAtLeast,
} from '../hooks/extras.ts'

// 날짜는 이 PC의 시간대로 만들어요. 그래서 어느 시간대에서 돌려도 같은 뜻이에요.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const local = (y: number, m: number, d: number, h: number, min = 0) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}T${p(h)}:${p(min)}:00`
}
const NOW = at(2026, 10, 15, 9, 30)

test('일정: 오늘 0시부터 모레 0시까지, 시간대 없이 물어요', () => {
  expect(localMidnight(NOW)).toBe('2026-10-15T00:00:00')
  expect(calendarArgs(NOW)).toEqual({ startTime: '2026-10-15T00:00:00', endTime: '2026-10-17T00:00:00', orderBy: 'startTime', pageSize: 30 })
  // 달이 넘어가도 맞아요
  expect(localMidnight(at(2026, 10, 31, 23), 1)).toBe('2026-11-01T00:00:00')
})

test('일정: 오늘·내일만 남기고, 취소된 것은 빼고, 오늘 종일 → 오늘 시각 순 → 내일 순으로 놓아요', () => {
  const data = {
    events: [
      { id: 'b', summary: '오후 회의', status: 'confirmed', start: { dateTime: local(2026, 10, 15, 14) }, end: { dateTime: local(2026, 10, 15, 15) } },
      { id: 'a', summary: '아침 회의', status: 'confirmed', start: { dateTime: local(2026, 10, 15, 8) }, end: { dateTime: local(2026, 10, 15, 9) } },
      { id: 'c', summary: '휴가', status: 'confirmed', start: { date: '2026-10-15' }, end: { date: '2026-10-16' } },
      { id: 'd', summary: '내일 일', status: 'confirmed', start: { dateTime: local(2026, 10, 16, 10) }, end: { dateTime: local(2026, 10, 16, 11) } },
      { id: 'e', summary: '모레 일', status: 'confirmed', start: { dateTime: local(2026, 10, 17, 10) }, end: { dateTime: local(2026, 10, 17, 11) } },
      { id: 'f', summary: '취소', status: 'cancelled', start: { dateTime: local(2026, 10, 15, 16) }, end: { dateTime: local(2026, 10, 15, 17) } },
      { id: 'g', status: 'confirmed', start: { dateTime: local(2026, 10, 15, 18) }, end: { dateTime: local(2026, 10, 15, 19) } },
    ],
  }
  const evs = parseEvents(data, NOW)
  expect(evs.map(e => e.id)).toEqual(['c', 'a', 'b', 'g', 'd'])
  expect(evs.find(e => e.id === 'g')!.title).toBe('(제목 없음)')
  expect(evs.find(e => e.id === 'd')!.day).toBe('tomorrow')
})

test('일정: 실제 응답처럼 시간대(+09:00)가 붙어 있어도 읽어요', () => {
  const data = { events: [{ id: 'x', summary: '도수 치료', status: 'confirmed', start: { dateTime: '2026-10-09T16:30:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-09T17:30:00+09:00' } }] }
  const start = Date.parse('2026-10-09T16:30:00+09:00')
  const evs = parseEvents(data, start)
  expect(evs.length).toBe(1)
  expect(evs[0]!.start).toBe(start)
})

test('일정: 종일 일정 날짜에 시각(T00:00:00Z)이 붙어 와도 오늘 일정이에요 (실제 커넥터 응답 모양)', () => {
  // 2026-10-15 실제 응답 그대로. 이 모양을 날짜만 오는 줄 알고 비교해서 «대본 촬영»이 빠졌어요.
  const data = {
    events: [{ id: '404c', summary: '대본 촬영', status: 'confirmed', eventType: 'DEFAULT', start: { date: '2026-10-15T00:00:00Z' }, end: { date: '2026-10-16T00:00:00Z' } }],
  }
  const evs = parseEvents(data, NOW)
  expect(evs.map(e => [e.title, e.day, e.allDay])).toEqual([['대본 촬영', 'today', true]])
  expect(eventTime(evs[0]!, NOW)).toBe('종일')
  // 며칠짜리도 같은 모양으로 와요
  const trip = parseEvents({ events: [{ id: 't', summary: '출장', start: { date: '2026-10-14T00:00:00Z' }, end: { date: '2026-10-17T00:00:00Z' } }] }, NOW)
  expect(trip.map(e => e.day)).toEqual(['today'])
})

test('일정: 어제부터 이어지는 일정은 오늘로 보고, 끝나는 시각을 «~»로 써요', () => {
  const data = {
    events: [
      { id: 'trip', summary: '출장', status: 'confirmed', start: { date: '2026-10-14' }, end: { date: '2026-10-17' } },
      { id: 'night', summary: '밤샘 배포', status: 'confirmed', start: { dateTime: local(2026, 10, 14, 23) }, end: { dateTime: local(2026, 10, 15, 2) } },
    ],
  }
  const evs = parseEvents(data, NOW)
  expect(evs.map(e => [e.id, e.day])).toEqual([['trip', 'today'], ['night', 'today']])
  expect(eventTime(evs[0]!, NOW)).toBe('종일')
  expect(eventTime(evs[1]!, NOW)).toBe('~02:00')
})

test('일정: 시각은 «09:30», 끝난 일정은 끝났다고 알아봐요', () => {
  const [ev] = parseEvents({ events: [{ id: 'a', summary: 'x', start: { dateTime: local(2026, 10, 15, 8, 5) }, end: { dateTime: local(2026, 10, 15, 9) } }] }, NOW)
  expect(eventTime(ev!, NOW)).toBe('08:05')
  expect(eventEnded(ev!, NOW)).toBe(true)
  expect(eventEnded(ev!, at(2026, 10, 15, 8, 30))).toBe(false)
})

test('일정: 모양이 다른 답은 빈 목록이에요', () => {
  expect(parseEvents(undefined, NOW)).toEqual([])
  expect(parseEvents({ summary: '개인일정' }, NOW)).toEqual([])
  expect(parseEvents({ events: [null, { id: 'x' }, { id: 'y', start: { dateTime: 'not a date' } }] }, NOW)).toEqual([])
})

test('고친 파일: 같은 파일은 한 줄로 합쳐 횟수를 세고, 방금 고친 것이 위로 와요', () => {
  let list = addChange([], 'D:\\work\\a.md', 1)
  list = addChange(list, 'D:/work/b.ts', 2)
  list = addChange(list, 'd:/work/A.md', 3) // 윈도우 경로는 대소문자를 가리지 않아요
  expect(list.map(c => [c.path, c.count])).toEqual([['d:/work/A.md', 2], ['D:/work/b.ts', 1]])
  // 50개까지만
  let many = list
  for (let i = 0; i < 60; i++) many = addChange(many, `/x/${i}.txt`, i)
  expect(many.length).toBe(50)
})

test('고친 파일: 대화 기록에서 만들 때는 성공한 Edit·Write·NotebookEdit 만 세요', () => {
  const msgs = [
    { toolUses: [{ tool: 'Write', input: { file_path: '/w/a.md' } }, { tool: 'Read', input: { file_path: '/w/r.md' } }] },
    { toolUses: [{ tool: 'Edit', input: { file_path: '/w/a.md' } }, { tool: 'Edit', input: { file_path: '/w/bad.md' }, isError: true }] },
    { toolUses: [{ tool: 'NotebookEdit', input: { notebook_path: '/w/n.ipynb' } }] },
  ]
  expect(changesFromMessages(msgs).map(c => [c.path, c.count])).toEqual([['/w/n.ipynb', 1], ['/w/a.md', 2]])
})

test('고친 파일: 이름과 폴더. 작업 폴더 안이면 폴더를 줄여 써요', () => {
  expect(changeLabel('D:/proj/src/app.ts', 'D:\\proj')).toEqual({ name: 'app.ts', dir: 'src' })
  expect(changeLabel('D:/proj/README.md', 'D:/proj/')).toEqual({ name: 'README.md', dir: '' })
  expect(changeLabel('C:/Users/me/.claude/x.md', 'D:/proj')).toEqual({ name: 'x.md', dir: 'C:/Users/me/.claude' })
  expect(changeLabel('d:/PROJ/a/b.md', 'D:/proj')).toEqual({ name: 'b.md', dir: 'a' })
  expect(changePrompt('D:/proj/src/app.ts')).toBe('이번 대화에서 D:/proj/src/app.ts 파일을 왜, 어떻게 바꿨는지 쉽게 설명해 줘.')
})

test('명령어 안내: 입력창에 넣을 글', () => {
  expect(guideCommand({ name: 'tui', arg: 'fullscreen', text: '' })).toBe('/tui fullscreen')
  expect(guideCommand({ name: 'clear', text: '' })).toBe('/clear')
  // 같은 명령이 두 번 들어 있지 않아요(버튼 key 가 겹치면 안 돼요)
  expect(new Set(COMMAND_GUIDE.map(g => g.name)).size).toBe(COMMAND_GUIDE.length)
})

test('명령 탭: 쓴 글을 명령으로 바꿔요', () => {
  expect(parseGuideInput('/capcut 릴스 편집')).toEqual({ guide: { name: 'capcut', text: '릴스 편집' } })
  expect(parseGuideInput('capcut')).toEqual({ guide: { name: 'capcut', text: '' } })
  expect(parseGuideInput('  /tui   fullscreen - 옆에 붙이기 ')).toEqual({ guide: { name: 'tui', arg: 'fullscreen', text: '옆에 붙이기' } })
  expect(parseGuideInput('/plugin:skill 플러그인 스킬')).toEqual({ guide: { name: 'plugin:skill', text: '플러그인 스킬' } })
  expect('error' in parseGuideInput('')).toBe(true)
  expect('error' in parseGuideInput('/한글명령 설명')).toBe(true)
  expect('error' in parseGuideInput('/rm;ls 설명')).toBe(true)
})

test('명령 탭: 기본 목록에서 뺀 것은 빼고, 넣은 것은 뒤에 붙여요. 같은 명령은 한 번만', () => {
  const list = effectiveGuide([{ name: 'capcut', text: '릴스 편집' }, { name: 'clear', text: '겹침' }], ['/clear', '/tui fullscreen'])
  const cmds = list.map(guideCommand)
  expect(cmds.includes('/clear')).toBe(false)
  expect(cmds.includes('/tui fullscreen')).toBe(false)
  expect(cmds.at(-1)).toBe('/capcut')
  expect(cmds.length).toBe(COMMAND_GUIDE.length - 2 + 1)
  // 넣은 것이 기본과 같으면 기본 하나만
  expect(effectiveGuide([{ name: 'compact', text: '다른 설명' }], []).filter(g => g.name === 'compact').length).toBe(1)
  expect(isDefaultGuide({ name: 'compact', text: '' })).toBe(true)
  expect(isDefaultGuide({ name: 'capcut', text: '' })).toBe(false)
  expect(guideKey({ name: 'tui', arg: 'fullscreen', text: '' })).toBe('cmd-tui-fullscreen')
})

test('점검: 버전 비교', () => {
  expect(versionAtLeast('2.1.300', '2.1.287')).toBe(true)
  expect(versionAtLeast('2.1.287', '2.1.287')).toBe(true)
  expect(versionAtLeast('2.1.286-dev.20260920', '2.1.287')).toBe(false)
  expect(versionAtLeast('2.2.0', '2.1.287')).toBe(true)
  expect(versionAtLeast('?', '2.1.287')).toBeUndefined()
})

test('점검: 커넥터 거절 이유를 «권한 없음 / 로그인 풀림 / 연결 안 됨»으로 가려서 고치는 법을 달리 적어요', () => {
  const tools = ['mcp__claude_ai_Gmail__search_threads']
  expect(connectorCheck('g', 'Gmail', 'claude.ai Gmail', tools, undefined).state).toBe('ok')
  const perm = connectorCheck('g', 'Gmail', 'claude.ai Gmail', tools, "Claude requested permissions to use mcp__claude_ai_Gmail__search_threads, but you haven't granted it yet.")
  expect(perm.state).toBe('bad')
  expect(perm.fix).toBe('/permissions 에서 mcp__claude_ai_Gmail__search_threads 허용')
  const auth = connectorCheck('g', 'Gmail', 'claude.ai Gmail', tools, 'Authentication required')
  expect(auth.detail).toBe('로그인이 풀렸어요')
  expect(auth.fix).toMatch(/다시 로그인/)
  const none = connectorCheck('g', 'Gmail', 'claude.ai Gmail', tools, 'MCP server "claude.ai Gmail" is not connected')
  expect(none.detail).toBe('연결이 안 돼 있어요')
  expect(none.fix).toMatch(/\/mcp 에서 «claude\.ai Gmail» 연결/)
})

test('승인 대기 알림: 무엇을 하려는지 한 줄로, 질문 도구는 빼요', () => {
  expect(permissionNote('AskUserQuestion', {})).toBeUndefined()
  expect(permissionNote('Bash', { command: 'npm   install\nleft-pad' })).toEqual({ title: '승인을 기다려요', body: 'Bash: npm install left-pad' })
  expect(permissionNote('Write', { file_path: '/w/a.md', content: '…' })!.body).toBe('Write: /w/a.md')
  expect(permissionNote('mcp__claude_ai_Gmail__send_message', { to: 'a@example.com' })!.body).toBe('claude_ai_Gmail · send_message')
  expect(permissionNote('ExitPlanMode', {})!.title).toBe('계획 승인을 기다려요')
  expect(permissionNote('Bash', { command: 'x'.repeat(300) })!.body.length).toBe(118)
})
