/** "@name" as one bidi unit (see ChannelName). */
export function Mention({ name, lang }: { name: string; lang?: string }) {
  return (
    <bdi class="mention" lang={lang}>
      @{name}
    </bdi>
  )
}
