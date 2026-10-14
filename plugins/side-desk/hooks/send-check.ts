// side-desk 발송 전 확인. `$`를 쓰지 않는 순수 함수라서 테스트가 쉬워요.
// 메일·광고·일정·드라이브 공유처럼 «바깥으로 나가는 도구»를 부르기 직전에 알아봐요.

export type SendJudgement = { label: string; detail: string; reason: string }

/** 읽기·조회로 시작하는 이름은 건드리지 않아요. */
const READONLY = /^(get|list|read|search|show|find|describe|check|preview|resolve|whoami|help|query|fetch|download|capture|view|explore|balance|models|jobs)_?/i
/** 이름 안에 이 말이 있으면 바깥으로 나가는 동작이에요. */
const OUTWARD = /(^|_)(send|reply|forward|post|publish|share|invite|deploy|boost|activate|respond|comment|broadcast|tweet)(_|$)/i
const CHANGE_VERB = /(create|activate|update|boost|delete|upload|finalize|connect|disconnect)/i

const make = (label: string, detail: string, reason: string): SendJudgement => ({ label, detail: detail.slice(0, 300), reason })

/**
 * 도구 이름(`mcp__서버__도구`)만 보고 판단해요. 바깥으로 나가는 도구면 설명을 돌려주고, 아니면 undefined예요.
 * side-desk 자신의 도구는 건드리지 않아요.
 */
export function judgeSend(tool: string): SendJudgement | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m) return undefined
  const server = m[1]!
  const name = m[2]!
  if (server === 'side-desk') return undefined
  const human = `${server.replace(/^(claude_ai_|plugin_)/, '')} · ${name}`
  if (/meta/i.test(server) && /^ads_/.test(name)) {
    return CHANGE_VERB.test(name) ? make('광고 계정 변경', human, '광고 계정을 바꾸는 도구예요. 돈이 나가거나 광고가 바로 나갈 수 있어요.') : undefined
  }
  if (/calendar/i.test(server)) {
    return /(create|update|delete|respond)/i.test(name) ? make('캘린더 변경', human, '참석자에게 초대나 변경 알림이 갈 수 있어요.') : undefined
  }
  if (/drive/i.test(server)) {
    return /(share|trash)/i.test(name) ? make('드라이브 공유·삭제', human, '파일을 다른 사람에게 공유하거나 휴지통으로 보내요.') : undefined
  }
  if (READONLY.test(name)) return undefined
  if (OUTWARD.test(name) || /^edit_message$/.test(name)) {
    return make('바깥으로 보내기', human, '메일·메시지·게시처럼 바깥으로 나가는 일이에요. 보내고 나면 되돌릴 수 없어요.')
  }
  return undefined
}

/** 확인창에 보여 줄 인자 요약. 받는 사람·제목·본문 위주로 뽑아요. */
export function summarizeArgs(input: Record<string, unknown>): string {
  const SKIP = new Set(['tool', 'agentId'])
  const PRIORITY = ['to', 'cc', 'bcc', 'subject', 'title', 'name', 'channel', 'text', 'body', 'message', 'content', 'summary', 'description', 'start', 'end', 'campaign_name']
  const lines: string[] = []
  const put = (k: string, v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s) lines.push(`${k}: ${s.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  for (const k of PRIORITY) if (k in input && !SKIP.has(k)) put(k, input[k])
  if (lines.length === 0) {
    const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !SKIP.has(k)))
    put('내용', rest)
  }
  return lines.slice(0, 7).join('\n')
}
