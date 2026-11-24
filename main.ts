// Pump.fun Paper Sprint: Any Bot Can Win — entry program.
//
// Strategy: "High-R Ladder + Sniper Padding" (see strategy.ts).
//   Leg A — buy the first time a coin's real SOL reserve R reaches >= 30 SOL
//   (and <= 45 SOL), 0.2 SOL; sell all at R >= 50 SOL or R <= 24 SOL.
//   Leg B — kit pilot sniper defaults at 0.02 SOL, only to clear the
//   20-coin guardrail (at most 15 coins, stop once ladder + padding >= 22).
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
