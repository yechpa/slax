/**
 * What the server accepts as an upload, checked before anything is sent: a refusal the
 * browser can predict should never cost a 10 MB upload. The server checks it all again
 * (and more: the real type from the content, archives, text encoding).
 */
import { formatBytes } from '../i18n/format.ts'
import { plural, t } from '../i18n/index.ts'

/** backend File::MAX_BYTES */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/** backend Message::MAX_FILES */
export const MAX_FILES_PER_MESSAGE = 10
/** backend File::EXTENSIONS */
export const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'zip'] as const
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'application/zip', 'application/x-zip-compressed'])

/** For the file picker: what the dialog offers by default. */
export const ACCEPT = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(',')

export type FileCheck = 'too_large' | 'empty_file' | 'type_not_allowed' | null

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null
}

/** Why the server would refuse this file outright, or null. Without an extension, the content decides (server side). */
export function checkFile(file: { name: string; size: number; type: string }): FileCheck {
  if (file.size > MAX_FILE_BYTES) return 'too_large'
  if (file.size === 0) return 'empty_file'
  const ext = extensionOf(file.name)
  if (ext !== null) return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? null : 'type_not_allowed'
  return file.type === '' || ALLOWED_TYPES.has(file.type) ? null : 'type_not_allowed'
}

/** Reason codes with their own sentence; anything else gets the generic one. */
const KNOWN = new Set([
  'too_large',
  'empty_file',
  'type_not_allowed',
  'extension_mismatch',
  'invalid_text',
  'zip_corrupt',
  'zip_encrypted',
  'zip_too_many_entries',
  'zip_unsafe_path',
  'zip_too_large',
  'zip_ratio_too_high',
  'quota_exceeded',
  'scanner_unavailable',
  'storage_unavailable',
  'rate_limited',
  'network',
  'rejected',
])

/**
 * The upload error code of an ApiError: the scanner's or the API's reason for a
 * `file_rejected`, the 503 codes, and a few derived ones (an over-size body stopped by
 * the web server or PHP is `too_large`).
 */
export function uploadErrorCode(error: { code: string; status: number; reason: string | null; fields?: Record<string, string[]> }): string {
  if (error.code === 'file_rejected') return error.reason ?? 'rejected'
  if (error.code === 'payload_too_large' || error.status === 413) return 'too_large'
  // PHP refused the body before Laravel saw a file (over upload_max_filesize).
  if (error.code === 'validation' && error.fields?.file) return 'too_large'
  return error.code
}

/** One translated sentence naming the file. */
export function uploadErrorText(code: string, name: string): string {
  // Said as "10 MB" (the limit is 10 MiB, a little more: nothing said to fit is refused).
  if (code === 'too_large') return t('upload.error.too_large', { name, limit: formatBytes(10_000_000) })
  return t(`upload.error.${KNOWN.has(code) ? code : 'generic'}`, { name })
}

export const tooManyFilesText = () => plural('upload.error.too_many_files', MAX_FILES_PER_MESSAGE)
