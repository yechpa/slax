import { describe, expect, it } from 'vitest'
import { App } from './app.tsx'

describe('App', () => {
  it('is a component', () => {
    expect(App).toBeTypeOf('function')
  })
})
