// The share card's words (the drawing itself needs a canvas, which Node does not have).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardText, shareText, shortUrl } from '../js/card.js'

const E = (n) => BigInt(n) * 10n ** 18n
const lit = { night: 312, outcome: 'LIT', word: 'LIT ×4', throwers: 5, mine: { wood: E(50), reward: E(3), lost: 0n } }
const smoked = { night: 313, outcome: 'SMOKED', word: 'SMOKED', throwers: 4, mine: { wood: E(50), reward: 0n, lost: E(2) } }

test('a card only for a night the player threw on: what we did together first, then my part', () => {
  assert.deepEqual(cardText(lit, 'EMBER', 18), { kicker: 'NIGHT 312 · LIT ×4', title: '5 of us lit night 312', line: 'My 50 wood came back, plus 3 new EMBER.' })
  assert.equal(cardText({ ...lit, throwers: 1 }, 'EMBER', 18).title, 'I lit night 312')
  assert.equal(cardText(smoked, 'EMBER', 18).title, 'Night 313 went up in smoke')
  assert.equal(cardText(smoked, 'EMBER', 18).line, '4 of us threw, not enough. 2 EMBER of my wood burned.')
  assert.equal(cardText({ ...smoked, throwers: 1 }, 'EMBER', 18).line, '2 EMBER of my wood burned. Back tomorrow night.')
  assert.equal(cardText({ ...lit, mine: null }, 'EMBER', 18), null)
  assert.equal(cardText(null, 'EMBER', 18), null)
})

test('a shared card names the night and brings the page address along', () => {
  const url = 'https://replaycourt.github.io/bonfire/web/'
  assert.deepEqual(shareText(lit, { symbol: 'EMBER', decimals: 18, url }), {
    title: 'Bonfire · night 312',
    text: "5 of us lit night 312 on Bonfire (LIT ×4). Throw wood on tonight's fire:",
    url,
  })
  assert.equal(shareText(smoked, { url }).text, "Night 313 went up in smoke on Bonfire. Help light tonight's fire:")
  assert.equal(shareText({ ...lit, mine: null }, { url }), null)
  assert.equal(shortUrl(url), 'replaycourt.github.io/bonfire/web')
})
