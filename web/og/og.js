// Draws the link preview into the page's canvas; document.body gets data-ready when it is done.
import { drawPoster } from '../js/card.js'

const poster = await drawPoster()
document.getElementById('poster').getContext('2d').drawImage(poster, 0, 0)
document.body.dataset.ready = '1'
