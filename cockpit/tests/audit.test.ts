import { describe, expect, test } from 'claude-code/testing'

import { testSummary } from '../hooks/register'

// Each test states what SHOULD happen. A failing test = a confirmed bug or gap in the live mod.
describe('AUDIT folding', () => {
  test('skipped tests stay visible in the folded line (pytest)', () => {
    expect(testSummary('==== 52 passed, 2 skipped in 1.20s ====')?.skipped).toBe(2)
  })
  test('skipped tests stay visible in the folded line (node --test)', () => {
    expect(testSummary('# tests 10\n# pass 8\n# fail 0\n# skipped 2\n')?.skipped).toBe(2)
  })
})
