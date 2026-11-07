// The share card's words (the drawing itself needs a canvas, which Node does not have).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardText } from '../js/card.js'

const E = (n) => BigInt(n) * 10n ** 18n

test('a card only for a night the player threw on, in the words of its outcome', () => {
  const lit = { night: 312, outcome: 'LIT', word: 'LIT ×4', mine: { wood: E(50), reward: E(3), lost: 0n } }
  assert.deepEqual(cardText(lit, 'EMBER', 18), { kicker: 'NIGHT 312 · LIT ×4', title: 'I helped light night 312', line: 'My 50 wood came back, plus 3 new EMBER.' })
  const smoked = { night: 313, outcome: 'SMOKED', word: 'SMOKED', mine: { wood: E(50), reward: 0n, lost: E(2) } }
  assert.equal(cardText(smoked, 'EMBER', 18).title, 'Night 313 went up in smoke')
  assert.equal(cardText({ ...lit, mine: null }, 'EMBER', 18), null)
  assert.equal(cardText(null, 'EMBER', 18), null)
})
