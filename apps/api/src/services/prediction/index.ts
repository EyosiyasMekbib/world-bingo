/**
 * Prediction market services — the binary order book.
 *
 * Named re-exports rather than `export *`: the five modules define their own
 * helper types, and a barrel that re-exported everything would break the day two
 * of them happened to pick the same name.
 */

export { PredictionMarketService } from './market.service.js'
export { PredictionOrderService } from './order.service.js'
export { PredictionMatchingService } from './matching.service.js'
export { PredictionSettlementService } from './settlement.service.js'
export { PredictionBookService } from './book.service.js'
