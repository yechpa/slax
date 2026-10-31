import { afterEach, describe, expect, it } from 'vitest'
import { publicConfig } from './publicConfig.ts'

function meta(name: string, content: string) {
  const tag = document.createElement('meta')
  tag.name = name
  tag.content = content
  document.head.append(tag)
}

afterEach(() => document.head.querySelectorAll('meta').forEach((m) => m.remove()))

describe('publicConfig', () => {
  it('reads the value the web server wrote into index.html', () => {
    meta('slax:turnstile-site-key', '0x4AAAAAAA-example')
    meta('slax:reverb-app-key', 'slax-dev')
    expect(publicConfig('turnstile-site-key')).toBe('0x4AAAAAAA-example')
    expect(publicConfig('reverb-app-key')).toBe('slax-dev')
  })

  it('has nothing when the page carries no such tag (development, end-to-end build)', () => {
    expect(publicConfig('turnstile-site-key')).toBeUndefined()
  })

  it('treats an empty tag as absent, so the build-time value still applies', () => {
    meta('slax:reverb-app-key', '  ')
    expect(publicConfig('reverb-app-key')).toBeUndefined()
  })
})
