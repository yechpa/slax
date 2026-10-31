/**
 * Message text as the server measures it. The server trims plain ASCII whitespace only
 * (bidi marks such as RLM at the edges are meaningful and kept) and counts characters
 * as code points, so the composer's counter, its Send button and the text actually sent
 * all use these two functions.
 */
/** backend Message::MAX_BODY, in code points. */
export const MAX_BODY = 4000

export const trimBody = (text: string) => text.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '')

/** Code points, like PostgreSQL's char_length: an emoji is one, not two UTF-16 units. */
export const charCount = (text: string) => [...text].length
