// Trailhead Pump 6h — entrypoint for the pump.fun replay bot.
// The grader runs `node main.ts`; the strategy lives in strategy.ts and the
// The wire shim is the kit's vendor/agentfun-bot.ts, copied verbatim (see its header).

import { runBot } from './vendor/agentfun-bot.ts';
import { makeBot, DEFAULT_SETTINGS } from './strategy.ts';

await runBot(makeBot(DEFAULT_SETTINGS));
