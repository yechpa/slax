import { plural, t } from '../../i18n/index.ts'

type Props = { href: string; replies: number; lastReply?: string }

/**
 * "-> 3 replies · last reply 10:02". The "->" is written once in logical
 * order; ">" is Bidi_Mirrored, so in Hebrew it reads "<-", pointing forward.
 */
export function ThreadLink({ href, replies, lastReply }: Props) {
  return (
    <a class="thread-link" href={href}>
      <span aria-hidden="true">-&gt;</span>
      <span class="thread-link__count">{plural('message.replies', replies)}</span>
      {lastReply && <span class="thread-link__last">· {t('message.lastReply', { time: lastReply })}</span>}
    </a>
  )
}
