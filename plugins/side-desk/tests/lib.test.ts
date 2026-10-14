import { expect, test } from 'claude-code/testing'
import {
  CLIP_MAX, CLIP_SCRIPT, CLIP_ITEM_SCRIPT, COACH_SKIP, applyUpdate, burn, clipInsertText, clipItemScript, clipRowText, clipTitle,
  describeBoard, extractFacts, isValidBrief, keptShare, parseClip, parseClipList, parseVerdict, untilText,
} from '../hooks/lib.ts'
import { judgeSend, summarizeArgs } from '../hooks/send-check.ts'

test('핀: 추가·시작·끝·결정', async () => {
  let b = applyUpdate({ todos: [], decisions: [] }, { add_todos: ['a', 'b'], open_decisions: ['q?'] })
  expect(b.todos.map(t => t.id).join(',')).toBe('t1,t2')
  b = applyUpdate(b, { start_todo: 't1' })
  expect(b.todos[0]!.isActive).toBe(true)
  b = applyUpdate(b, { done_todos: ['t1'], decide: [{ id: 'd1', answer: 'y' }] })
  expect(b.todos[0]!.isDone).toBe(true)
  expect(b.todos[0]!.isActive).toBe(false)
  expect(b.decisions.length).toBe(0)
  expect(describeBoard({ todos: [], decisions: [] })).toMatch(/비어 있음/)
})

test('사용량: 초기화 문구와 소모 속도', async () => {
  const now = Date.parse('2026-10-14T00:00:00Z')
  expect(untilText('2026-10-14T02:10:00Z', now)).toBe('2시간 10분 뒤 초기화')
  expect(untilText('2026-10-14T00:30:00Z', now)).toBe('30분 뒤 초기화')
  const base = { at: now, windows: [{ kind: 'five_hour', percentUsed: 10 }] }
  const b = burn({ kind: 'five_hour', percentUsed: 30 }, base, now + 3_600_000)
  expect(Math.round(b!.perHour)).toBe(20)
  expect(Math.round(b!.hoursLeft)).toBe(4)
})

test('이어가기: 바꾼 파일과 커밋을 뽑아요', async () => {
  const messages = [
    { role: 'user', text: '보고서를 정리해 줘', toolUses: [] },
    { role: 'user', text: '<system-reminder>무시</system-reminder>', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool: 'Edit', input: { file_path: 'C:/work/report.md' } },
        { tool: 'Bash', input: { command: 'git commit -m "report"' }, text: '[main abc1234] report' },
      ],
    },
  ]
  const f = extractFacts(messages)
  expect(f.filesModified).toEqual(['C:/work/report.md'])
  expect(f.commits[0]).toBe('report (abc1234)')
  expect(f.lastUserMessage).toBe('보고서를 정리해 줘')
  expect(isValidBrief('## 지금 하던 일\n없음')).toBe(true)
  expect(isValidBrief('안녕하세요')).toBe(false)
})

test('프롬프트 가이드: 건너뛸 요청과 판정 읽기', async () => {
  for (const s of ['/clear', '네', '진행해', 'https://example.com/a', '좋아요.']) expect(COACH_SKIP.test(s)).toBe(true)
  for (const s of ['이 파일 좀 정리해 줘', '보고서 초안을 써 줘']) expect(COACH_SKIP.test(s)).toBe(false)
  expect(parseVerdict('{"verdict":"fine"}')?.verdict).toBe('fine')
  const v = parseVerdict('앞말 {"verdict":"improve","why":"대상이 없어요","rewrite":"a.xlsx 정리해 줘"} 뒷말')
  expect(v?.verdict).toBe('improve')
  expect(parseVerdict('JSON 아님')).toBe(undefined)
  expect(keptShare('표를 정리해 줘 지금 바로', '표를 정리해 주세요 지금 바로 부탁해요')).toBeGreaterThan(0.5)
  expect(keptShare('표를 정리해 줘 지금 바로', '전혀 다른 내용입니다 완전히')).toBeLessThan(0.5)
})

test('발송 전 확인: 바깥으로 나가는 도구만 잡아요', async () => {
  for (const t of ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
    'mcp__claude_ai_meta__ads_create_campaign', 'mcp__claude_ai_meta__ads_activate_entity', 'mcp__claude_ai_Google_Calendar__create_event',
    'mcp__claude_ai_Google_Calendar__respond_to_event', 'mcp__claude_ai_Google_Drive__share_file', 'mcp__plugin_discord_discord__reply']) {
    expect(`${t} => ${judgeSend(t) ? 'send' : 'pass'}`).toBe(`${t} => send`)
  }
  for (const t of ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__create_draft',
    'mcp__claude_ai_meta__ads_get_ad_accounts', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Google_Drive__search_files',
    'mcp__side-desk__pin', 'Bash']) {
    expect(`${t} => ${judgeSend(t) ? 'send' : 'pass'}`).toBe(`${t} => pass`)
  }
  const s = summarizeArgs({ tool: 'x', agentId: 'a', to: 'a@b.com', subject: '견적서', body: '안녕하세요\n본문', extra: 1 })
  expect(s).toBe('to: a@b.com\nsubject: 견적서\nbody: 안녕하세요 본문')
})

test('클립보드: 출력 읽기와 입력창에 넣을 글', async () => {
  expect(parseClip('TEXT\r\n안녕\r\n').kind).toBe('text')
  expect((parseClip('TEXT\r\n안녕\r\n') as any).text).toBe('안녕')
  expect(parseClip('TEXT\n   \n').kind).toBe('empty')
  expect(parseClip('EMPTY').kind).toBe('empty')
  const img = parseClip('IMAGE\nC:\\x\\clip.png\n10x20\n2048\n') as any
  expect(img.kind).toBe('image')
  expect(clipTitle(img)).toBe('이미지 · 10x20 · 2KB')
  expect(clipInsertText(img, p => p.replace(/\\/g, '/'))).toBe('[클립보드 이미지] C:/x/clip.png')
  expect(parseClip('ERROR\n권한이 없어요').kind).toBe('error')
  const long = parseClip('TEXT\n' + 'a'.repeat(CLIP_MAX + 50)) as any
  expect(long.truncated).toBe(true)
  expect(clipInsertText(long, p => p)).toMatch(/까지만 넣었어요/)
})

test('클립보드 기록: 목록 읽기와 항목 스크립트', async () => {
  const out = [
    '{"id":"639275000000000001","at":"13:57:00","kind":"text","chars":283,"preview":"첫 줄\\n둘째 줄"}',
    '{"id":"639275000000000002","at":"13:56:11","kind":"image"}',
    '이상한 줄',
    '{깨진 json',
  ].join('\r\n')
  const parsed = parseClipList(out)
  expect(parsed.items.length).toBe(2)
  expect(parsed.items[0]!.preview).toBe('첫 줄\n둘째 줄')
  expect(parseClipList('STATUS AccessDenied').problem).toBe('AccessDenied')
  expect(clipRowText(parsed.items[0]!)).toBe('13:57 글 283자 · 첫 줄 둘째 줄')
  expect(clipRowText(parsed.items[1]!)).toBe('13:56 이미지')
  // 숫자만 스크립트에 끼워 넣어요
  expect(clipItemScript('639275000000000001')).toMatch(/-eq '639275000000000001'/)
  expect(clipItemScript("1'; Remove-Item C:\\ -Recurse; '")).toBe(undefined)
})

test('공개 사본에 개인·회사 흔적이 없어요', async () => {
  for (const script of [CLIP_SCRIPT, CLIP_ITEM_SCRIPT]) {
    expect(script).not.toMatch(/ft-desk|futuretalent|kbjhh/i)
  }
  expect(CLIP_SCRIPT).toContain('side-desk')
})
