/**
 * The reaction picker's emoji: common ones, in their emoji presentation form (with
 * U+FE0F where the character defaults to text, e.g. ❤️ rather than ❤), so the picker
 * always sends the same string for the same emoji. The server keeps reactions exactly as
 * sent (❤ and ❤️ are two different reactions there); chips toggle what the server has.
 * Each is one grapheme of at most 16 bytes, as the server requires.
 */
export const PICKER_EMOJI = [
  '👍', '👎', '😀', '😂', '😅', '😊', '😍', '🤔',
  '😮', '😢', '😡', '🙏', '👏', '🙌', '🎉', '🚀',
  '🔥', '❤️', '💯', '✅', '❌', '👀', '💡', '⚠️',
  '🐛', '🛠️', '📌', '📎', '☕', '🍕', '🎯', '🏆',
  '⭐', '✨', '👋', '🤝', '💪', '🙈', '🤯', '🤩',
] as const

/** Columns of the picker grid (arrow keys move by one, or by a row). */
export const PICKER_COLUMNS = 8
