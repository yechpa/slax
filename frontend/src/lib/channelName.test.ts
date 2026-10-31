import { describe, expect, it } from 'vitest'
import { CHANNEL_NAME, channelNameProblem, normalizeChannelName } from './channelName.ts'

/** backend ChannelController::store: 'regex:/^[a-z0-9][a-z0-9-]{0,39}$/' */
const BACKEND = /^[a-z0-9][a-z0-9-]{0,39}$/

describe('channel names', () => {
  it('channel_name_validation_matches_backend_regex', () => {
    const samples = [
      'general',
      'a',
      '0',
      'ops-oncall',
      'a-',
      'v1-2-3',
      'x'.repeat(40),
      'x'.repeat(41),
      '',
      '-start',
      'Upper',
      'with space',
      'under_score',
      'café',
      'שלום',
      'a.b',
      'a\n',
      '\nb',
      '9lives',
      '--',
    ]
    for (const name of samples) {
      expect(channelNameProblem(name) === null, JSON.stringify(name)).toBe(BACKEND.test(name))
    }
    expect(CHANNEL_NAME.source).toBe(BACKEND.source)
    // Each refusal says why.
    expect(channelNameProblem('')).toBe('empty')
    expect(channelNameProblem('-start')).toBe('start')
    expect(channelNameProblem('under_score')).toBe('chars')
    expect(channelNameProblem('x'.repeat(41))).toBe('long')
  })

  it('helps while typing: lower case, spaces as dashes', () => {
    expect(normalizeChannelName('Release Notes')).toBe('release-notes')
    expect(normalizeChannelName('ÉQUIPE')).toBe('équipe')
  })
})
