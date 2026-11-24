// Trailhead Pump 6h — entrypoint for the pump.fun replay bot.
// The grader runs `node main.ts`; the strategy lives in strategy.ts and the
// wire shim is vendor/shim.ts, written fresh for this entry.

import { runBot } from './vendor/shim.ts';
import { makeBot, DEFAULT_SETTINGS } from './strategy.ts';

await runBot(makeBot(DEFAULT_SETTINGS));
