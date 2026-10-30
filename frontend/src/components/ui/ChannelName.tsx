/**
 * "#general" as one bidi unit: the sigil and the name share a <bdi>, so the
 * whole reference takes the direction of the name. A Latin channel reads
 * "#general" in a Hebrew sentence (without the <bdi> the "#" drifts to the
 * other end: "general#"); a Hebrew channel reads right to left, sigil first.
 */
export function ChannelName({ name, lang }: { name: string; lang?: string }) {
  return (
    <bdi class="channel-name" lang={lang}>
      #{name}
    </bdi>
  )
}
