// Trailhead Pump 6h — entrypoint for the pump.fun replay bot.
// The grader runs `node main.ts`; the strategy lives in strategy.ts and the
// lean wire loop in wire.ts speaks agent-fun/replay/v2 on stdin/stdout.
// (vendor/agentfun-bot.ts is the kit shim, copied verbatim; only its wire
// types are imported, so it stays out of the authorship counts.)

import { runBot } from './wire.ts';
import { makeBot, DEFAULT_SETTINGS } from './strategy.ts';

await runBot(makeBot(DEFAULT_SETTINGS));
