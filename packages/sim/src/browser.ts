// Browser entry: everything in index.ts except the Node-only tutorial file loader.
export * from './types.ts';
export * from './rng.ts';
export { generateMap, W, H } from './map.ts';
export { computeSnapshot, fullPower, isFrozen, isHealthyDC, isOwnedDC, TOP_K } from './connectivity.ts';
export {
  createGame, blankGameState, setBugKey, applyOp, stepTic, cloneState, totalPower, globalTic, dirDelta, neighbors4,
  safeLevel, thresholdMilli, bugCap, dcStatus, cureToProtect, checkGoal, recomputeVision,
  RUN_TURNS, SPAWN_START, IMMUNITY, GROWTH_INTERVAL, SPREAD_INTERVAL, LAND_INCOME_INTERVAL, MAX_PAUSES,
  type GameConfig,
} from './game.ts';
export { stateHash, HASH_VERSION } from './hash.ts';
export { preview, verifyLog, playLog, type QueuePreview, type VerifyInput, type VerifyResult } from './verify.ts';
export { InputController, type ControllerEvent } from './controller.ts';
export { hintTriggers, TUTORIAL_IDS } from './hints.ts';
export * from './product.ts';
export * from './mp.ts';
export { mpBotOps, mpBotPlay } from './mpbot.ts';
