import { expect, test } from 'claude-code/testing'
import { MAIL_BODY_MAX, cellWidth, padCells, cleanMailBody, mailAccount, mailActionPrompt, mailTime, mcpErrorText, mcpJson, parseThread, parseThreadList, safeMailUrl, senderName } from '../hooks/lib.ts'

test('칸 수: 한글은 두 칸, 영문·숫자는 한 칸으로 세고 칸 수로 채워요', async () => {
  expect(cellWidth('5시간')).toBe(5)
  expect(cellWidth('7일')).toBe(3)
  expect(cellWidth('abc')).toBe(3)
  // padEnd 로 채우면 «5시간»과 «7일»의 막대 시작 자리가 달랐어요
  expect(cellWidth(padCells('5시간', 6))).toBe(6)
  expect(cellWidth(padCells('7일', 6))).toBe(6)
  expect(padCells('지출 한도', 6)).toBe('지출 한도')
})

test('메일: MCP 결과에서 JSON 을 꺼내요', async () => {
  expect(mcpJson({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 })
  expect(mcpJson({ content: [], structuredContent: { b: 2 } })).toEqual({ b: 2 })
  // 빈 답은 «0건»이에요(도구 설명: 빈 {} 은 결과 없음)
  expect(mcpJson({ content: [] })).toEqual({})
  expect(mcpJson({ content: [{ type: 'text', text: '깨진 답' }] })).toBe(undefined)
  expect(mcpErrorText({ content: [{ type: 'text', text: 'Authentication\n required' }], isError: true })).toBe('Authentication required')
})

test('메일: 목록은 첫 메일 제목, 마지막 메일 보낸 사람·시각, 안 읽음 여부를 가져요', async () => {
  const rows = parseThreadList({
    threads: [
      {
        id: 't1',
        messageCount: 2,
        messages: [
          { date: '2026-10-14T01:00:00Z', sender: 'b@x.com', subject: 'Re: 안건', labelIds: ['INBOX', 'UNREAD'] },
          { date: '2026-10-13T01:00:00Z', sender: 'a@x.com', subject: '안건', labelIds: ['INBOX'] },
        ],
      },
      { id: 't2', messages: [{ date: '2026-10-12T01:00:00Z', sender: 'c@x.com', subject: '  ', labelIds: [] }] },
      { id: '', messages: [{ subject: 'id 없음' }] },
      { id: 't3', messages: [] },
    ],
  })
  expect(rows.length).toBe(2)
  expect(rows[0]).toEqual({ id: 't1', subject: '안건', from: 'b@x.com', date: '2026-10-14T01:00:00Z', unread: true, count: 2 })
  expect(rows[1]!.subject).toBe('(제목 없음)')
  expect(rows[1]!.unread).toBe(false)
  expect(parseThreadList({})).toEqual([])
  expect(parseThreadList(undefined)).toEqual([])
})

test('메일: 본문은 최신부터, 너무 길면 잘라요', async () => {
  const long = 'ㄱ'.repeat(MAIL_BODY_MAX + 10)
  const t = parseThread({
    id: 't1',
    viewUrl: 'https://mail.google.com/mail/?authuser=me@x.com#all/thread-f:1',
    messages: [
      { date: '2026-10-13T01:00:00Z', sender: 'a@x.com', subject: '안건', plaintextBody: '첫 메일' },
      { date: '2026-10-14T01:00:00Z', sender: 'b@x.com', subject: 'Re: 안건', plaintextBody: long },
    ],
  })!
  expect(t.subject).toBe('안건')
  expect(t.total).toBe(2)
  expect(t.messages[0]!.from).toBe('b@x.com')
  expect(t.messages[0]!.body.length).toBe(MAIL_BODY_MAX)
  expect(t.messages[0]!.cut).toBe(true)
  expect(t.messages[1]!.body).toBe('첫 메일')
  // 본문이 없으면 앞부분(snippet)이라도
  expect(parseThread({ id: 'x', messages: [{ snippet: '미리보기' }] })!.messages[0]!.body).toBe('미리보기')
  expect(parseThread({})).toBe(undefined)
})

test('메일: 보낸 사람 이름, 시각, 계정, 링크', async () => {
  expect(senderName('홍길동 <hong@x.com>')).toBe('홍길동')
  expect(senderName('"Doe, Jane" <d@x.com>')).toBe('Doe, Jane')
  expect(senderName('<only@x.com>')).toBe('only')
  expect(senderName('notify-noreply@google.com')).toBe('notify-noreply')

  const now = new Date(2026, 9, 15, 15, 0).getTime()
  expect(mailTime(new Date(2026, 9, 15, 9, 5).toISOString(), now)).toBe('09:05')
  expect(mailTime(new Date(2026, 9, 13, 9, 5).toISOString(), now)).toBe('10/13')
  expect(mailTime('엉뚱한 값', now)).toBe('')

  expect(mailAccount('https://mail.google.com/mail/?authuser=me@example.com#all/thread-f:1')).toBe('me@example.com')
  expect(mailAccount(undefined)).toBe('')

  expect(safeMailUrl('https://mail.google.com/mail/?authuser=a#all/thread-f:1|msg-f:1')).toBe('https://mail.google.com/mail/?authuser=a#all/thread-f:1|msg-f:1')
  // Gmail 이 아닌 주소, 따옴표·공백이 섞인 주소는 브라우저로 넘기지 않아요(PowerShell 문자열을 깨지 않게)
  expect(safeMailUrl('https://evil.example/')).toBe(undefined)
  expect(safeMailUrl("https://mail.google.com/'; Remove-Item C:\\ ;'")).toBe(undefined)
  expect(safeMailUrl(undefined)).toBe(undefined)
})

test('메일: «>» 글에는 제목·보낸 사람·날짜·스레드 번호와 할 일이 들어가요', async () => {
  const text = mailActionPrompt({ id: 't9', subject: '견적 문의', from: '홍길동 <h@x.com>', date: '2026-10-14T01:00:00Z' })
  expect(text).toBe('메일 「견적 문의」(홍길동 <h@x.com>, 2026-10-14, Gmail 스레드 t9)을 Gmail에서 읽고 내용을 확인한 뒤, 내가 해야 할 조치사항을 찾아 줘.')
  expect(mailActionPrompt({ id: 't1', subject: '제목', from: '', date: '' })).toBe('메일 「제목」(Gmail 스레드 t1)을 Gmail에서 읽고 내용을 확인한 뒤, 내가 해야 할 조치사항을 찾아 줘.')
})

// HTML 뉴스레터를 Gmail PLAIN_TEXT 로 받으면 이런 모양이 돼요(실제 메일의 모양을 본떠서 이름·주소는 지어냈어요)
const NEWSLETTER = ' 2026 가을 세미나\n\n| |\n\n| 2026 가을 세미나 일하는 방식이 바뀐다 11. 3. 화요일 | 10:00–16:00 | 서울 예시홀 |\n| 대상 | 팀장 및 실무자 100명 |\n| 참가비 | 50,000원 |\n\n| |\n| 세미나 신청하기 →[](https://click.example.com/v2/click/QUJDREVGRw) |\n\n| PROGRAM |\n| KEYNOTE 10:00–11:00 |\n\n| |\n| 일을 다시 나누는 법 홍길동 · 예시대학교 교수 | |\n\n| |\n\n| |\n| [예시 뉴스레터] news@example.com | 02-000-0000 수신거부[](https://click.example.com/unsubscribe/1?token=QUJD) | Unsubscribe[](https://click.example.com/unsubscribe/1?token=QUJD) |\n| |\n| |'

test('메일 본문: 표 기호·빈 링크·추적 주소를 걷어 내요', async () => {
  expect(cleanMailBody(NEWSLETTER)).toBe(
    [
      '2026 가을 세미나',
      '',
      '2026 가을 세미나 일하는 방식이 바뀐다 11. 3. 화요일 · 10:00–16:00 · 서울 예시홀',
      '대상: 팀장 및 실무자 100명',
      '참가비: 50,000원',
      '',
      '세미나 신청하기',
      '',
      'PROGRAM',
      'KEYNOTE 10:00–11:00',
      '',
      '일을 다시 나누는 법 홍길동 · 예시대학교 교수',
      '',
      '[예시 뉴스레터] news@example.com · 02-000-0000 수신거부 · Unsubscribe',
    ].join('\n'),
  )
})

test('메일 본문: 링크 글은 남기고, 맨 주소는 도메인만, 굵게·구분선·인용은 정리해요', async () => {
  const raw = [
    '**안녕하세요** 팀장님,',
    '자세한 내용은 [여기](https://example.com/a?b=c)를 보세요.',
    '주소: https://www.example.co.kr/very/long/path?x=1 끝',
    '&nbsp;&nbsp;A &amp; B',
    '----------',
    '',
    '',
    '',
    '2026년 10월 14일 (화) 오후 1:00, 홍길동님이 작성:',
    '> 이전 메일 첫 줄',
    '> 이전 메일 둘째 줄',
  ].join('\n')
  expect(cleanMailBody(raw)).toBe(
    ['안녕하세요 팀장님,', '자세한 내용은 여기를 보세요.', '주소: ‹example.co.kr› 끝', 'A & B', '', '(앞 메일 인용 2줄은 접었어요)'].join('\n'),
  )
})
