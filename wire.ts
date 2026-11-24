// Lean wire loop for agent-fun/replay/v2 — a fast, allocation-light replacement
// for the kit shim's runBot (vendor/agentfun-bot.ts, kept byte-identical; only
// its wire types are imported here, so it stays out of the authorship counts).
//
// Why: the server amplifies per-batch CPU ~100x, and the kit shim pays BigInt
// conversions of every event's reserve fields, Map building and validation on
// every batch. This loop makes the same state transitions and sends the same
// replies byte for byte, but stores reserves as numbers (Number(decimal
// string) == Number(BigInt(decimal string)): the same correctly-rounded
// double, and the strategy only ever reads them through Number(...)) and
// positions as the original decimal strings (the strategy only ever reads
// them through Number(...) and passes token_amount through to sell orders
// verbatim). No clock, no randomness, no network: deterministic, like the shim.
//
// The strategy sees a BotState-compatible facade: hello, curves, positions,
// pending, txFeeLamports(), freeCashLamports(), committedPositionCount(),
// maxBuyLamports(mint). It is NOT a BotState instance (it holds numbers and
// strings where BotState holds bigints), so runBot passes it through a cast;
// everything the strategy does with it is identical either way.

import type {
  Account,
  Batch,
  Bot,
  BotState,
  Done,
  Hello,
  Pubkey,
} from './vendor/agentfun-bot.ts';

export const PROTOCOL = 'agent-fun/replay/v2';
/** Harness -> bot lines are at most this many UTF-8 bytes, the `\n` not counted (1 MiB). */
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
/** Bot -> harness lines are at most this many UTF-8 bytes, the `\n` not counted (64 KiB). */
export const MAX_BOT_LINE_BYTES = 65_536;
export const BPS = 10_000;

const U64_MAX_STR = '18446744073709551615';
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** 1-64 of [A-Za-z0-9_-], not starting with `_`: ids starting with `_` are the harness's closes. */
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

/** The harness sent something this loop cannot follow. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** The bot returned something the harness would treat as a protocol violation. */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

// ---------------------------------------------------------------- state

/** A bonding curve the bot has seen, at its latest known reserves (numbers, not bigints). */
export interface LeanCurve {
  readonly mint: Pubkey;
  /** Slot of its CreateEvent; null when first seen through a trade or a mark. */
  created_slot: number | null;
  virtual_token_reserves: number;
  virtual_quote_reserves: number;
  real_token_reserves: number;
  real_quote_reserves: number;
  /** Slot of the trade the reserves follow (the create slot until the first trade). */
  reserves_slot: number;
  /** TradeEvents seen on it. */
  trades: number;
  /** Its CompleteEvent arrived: no more orders (they would be rejected token_complete). */
  complete: boolean;
}

/** A held position: the original decimal strings, verbatim. */
export interface LeanHolding {
  token_amount: string;
  /** SOL spent on the tokens still held (fees included). */
  cost_lamports: string;
}

/** A sent order, as it went on the wire. Amounts are canonical decimal strings. */
export type LeanOrder =
  | { side: 'buy'; client_id: string; mint: Pubkey; quote_lamports: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; mint: Pubkey; token_amount: string; max_slippage_bps: number };

/** An order sent and not yet reported back in a fill. */
export interface LeanPending {
  readonly order: LeanOrder;
  /** Seq and slot of the batch it was decided on. */
  readonly seq: number;
  readonly decided_slot: number;
}

/**
 * Everything the bot knows, kept current by runBot before each callback.
 * Same transitions as the kit shim's BotState, same field layout the strategy
 * uses — only the numeric representation differs (see the header note).
 */
export class LeanState {
  readonly hello: Hello;
  /** Seq of the batch being answered (-1 before the first batch). */
  seq = -1;
  /** Slot of the batch being answered (-1 before the first batch). */
  slot = -1;
  /** The account as of the latest batch (or done). */
  account: Account;
  /** account.cash_lamports as a number. Orders still pending are not deducted: see freeCashLamports. */
  cash: number;
  /** Positions with tokens, by mint. */
  readonly positions = new Map<Pubkey, LeanHolding>();
  /** Every curve seen, by mint, in first-seen order. */
  readonly curves = new Map<Pubkey, LeanCurve>();
  /** Orders sent and not yet reported in a fill, by client_id, in send order. */
  readonly pending = new Map<string, LeanPending>();
  #next = 1;
  readonly #txFee: number;
  readonly #maxOrderBps: number;

  constructor(hello: Hello) {
    this.hello = hello;
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
    this.cash = Number(hello.capital.lamports);
    this.#txFee = Number(hello.fees.base_fee_lamports) + Number(hello.fees.priority_fee_lamports);
    this.#maxOrderBps = hello.caps.max_order_bps_of_real_reserve;
  }

  /** Base + priority fee every sent order pays, filled or not. */
  txFeeLamports(): number {
    return this.#txFee;
  }

  /**
   * The size cap on this mint now: the most this batch's buys on it may spend together; 0 when
   * unknown or complete. Exact: real reserves are <= ~8.5e10 lamports and bps <= 10000, so the
   * product is an exact integer < 2^53, the remainder is exact, and the quotient of the exact
   * multiple is exact — identical to the shim's bigint (real * bps) / 10000n.
   */
  maxBuyLamports(mint: Pubkey): number {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0;
    const p = c.real_quote_reserves * this.#maxOrderBps;
    return (p - (p % BPS)) / BPS;
  }

  /** Mints held plus mints with a buy pending: what counts against caps.max_open_positions. */
  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    return mints.size;
  }

  /**
   * Cash minus what pending orders will take if they fill (buy amounts and every tx fee). May go
   * negative. Exact: cash and every pending amount are integers < 2^53.
   */
  freeCashLamports(): number {
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= this.#txFee;
      if (p.order.side === 'buy') free -= Number(p.order.quote_lamports);
    }
    return free;
  }

  /** Fold a batch in: its fills, account, marks and events (in that order). runBot calls this. */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.#newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = Number(m.virtual_token_reserves);
      curve.virtual_quote_reserves = Number(m.virtual_quote_reserves);
      curve.real_token_reserves = Number(m.real_token_reserves);
      curve.real_quote_reserves = Number(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = Number(e.virtual_token_reserves);
        curve.virtual_quote_reserves = Number(e.virtual_quote_reserves);
        curve.real_token_reserves = Number(e.real_token_reserves);
        curve.real_quote_reserves = 0;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = Number(e.virtual_token_reserves);
        curve.virtual_quote_reserves = Number(e.virtual_quote_reserves);
        curve.real_token_reserves = Number(e.real_token_reserves);
        curve.real_quote_reserves = Number(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  /** Fold the final account in. runBot calls this before onDone. */
  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  /**
   * Validate what onBatch returned and turn it into wire orders (assigning missing client_ids,
   * o1, o2, ... in reply order, exactly like the shim). Throws OrderError on anything the
   * harness would call a protocol violation, and on more orders than
   * hello.caps.max_orders_per_batch. Does not record them.
   */
  toOrders(result: unknown): LeanOrder[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new OrderError(`batch ${this.seq}: onBatch must return an array of orders, got ${describe(result)}`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new OrderError(
        `batch ${this.seq}: onBatch returned ${result.length} orders, over hello.caps.max_orders_per_batch (${cap}); ` +
          `the harness rejects the orders past the cap and fails the run on a reply far over it, so send at most ${cap} per batch`,
      );
    }
    const checked = result.map((o: unknown, i: number) => checkOrder(o, `batch ${this.seq} order ${i}`));
    const taken = new Set<string>();
    for (const o of checked) if (o.client_id !== undefined) taken.add(o.client_id);
    return checked.map((o) => {
      const client_id = o.client_id ?? this.#freeId(taken);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: o.amount, max_slippage_bps: o.max_slippage_bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: o.amount, max_slippage_bps: o.max_slippage_bps };
    });
  }

  /** Record orders as sent on the current batch: they stay in `pending` until their fill arrives. */
  recordOrders(orders: readonly LeanOrder[]): void {
    for (const order of orders) {
      this.pending.set(order.client_id, { order, seq: this.seq, decided_slot: this.slot });
    }
  }

  #freeId(taken: Set<string>): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!taken.has(id)) return id;
    }
  }

  #newCurve(mint: Pubkey, created: number | null, slot: number): LeanCurve {
    const curve: LeanCurve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0,
      virtual_quote_reserves: 0,
      real_token_reserves: 0,
      real_quote_reserves: 0,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  #setAccount(account: Account): void {
    this.account = account;
    this.cash = Number(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      if (Number(p.token_amount) > 0) {
        this.positions.set(p.mint, { token_amount: p.token_amount, cost_lamports: p.cost_lamports });
      }
    }
  }
}

interface CheckedOrder {
  side: 'buy' | 'sell';
  client_id: string | undefined;
  mint: Pubkey;
  amount: string;
  max_slippage_bps: number;
}

const BUY_KEYS = new Set(['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps']);
const SELL_KEYS = new Set(['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps']);

function checkOrder(value: unknown, where: string): CheckedOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OrderError(`${where}: expected an order object, got ${describe(value)}`);
  const o = value as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') throw new OrderError(`${where}: side must be "buy" or "sell", got ${describe(o.side)}`);
  const allowed = o.side === 'buy' ? BUY_KEYS : SELL_KEYS;
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) throw new OrderError(`${where}: unknown key "${k}" on a ${o.side} order`);
  }
  if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) throw new OrderError(`${where}: mint must be a base58 address, got ${describe(o.mint)}`);
  const amountKey = o.side === 'buy' ? 'quote_lamports' : 'token_amount';
  const amount = toU64String(o[amountKey], `${where}: ${amountKey}`);
  const bps = o.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new OrderError(`${where}: max_slippage_bps must be an integer 0..10000, got ${describe(bps)}`);
  }
  let client_id: string | undefined;
  if (o.client_id !== undefined) {
    if (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id)) {
      throw new OrderError(`${where}: client_id must be 1-64 of [A-Za-z0-9_-] not starting with _ (reserved for the harness's closes), got ${describe(o.client_id)}`);
    }
    client_id = o.client_id;
  }
  return { side: o.side, client_id, mint: o.mint, amount, max_slippage_bps: bps };
}

/**
 * An amount as a canonical u64 decimal string; throws OrderError when it is not one.
 * Strings pass through verbatim (they arrive canonical from the harness or from a
 * bigint the strategy built); a 20-digit string is range-checked by a same-length
 * lexicographic compare against 2^64-1.
 */
function toU64String(value: unknown, what = 'amount'): string {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 18_446_744_073_709_551_615n) {
      throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
    }
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
    }
    return String(value);
  }
  if (typeof value === 'string' && U64_RE.test(value)) {
    if (value.length === 20 && value > U64_MAX_STR) {
      throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
    }
    return value;
  }
  throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
}

function describe(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

// ---------------------------------------------------------------- the line loop

/**
 * Split a byte stream into lines (`\n`-terminated, a trailing `\r` dropped).
 * A line longer than MAX_HARNESS_LINE_BYTES throws ProtocolError; an
 * unterminated last line is yielded.
 */
async function* readLines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  let buf = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buf = buf.length === 0 ? bytes : Buffer.concat([buf, bytes]);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) break;
      let line = buf.subarray(start, nl);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > MAX_HARNESS_LINE_BYTES) throw new ProtocolError(`input line ${line.length} bytes is over ${MAX_HARNESS_LINE_BYTES}`);
      yield line.toString('utf8');
      start = nl + 1;
    }
    if (start > 0) buf = buf.subarray(start);
  }
  if (buf.length > 0) {
    let line = buf;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    yield line.toString('utf8');
  }
}

/** Where replies go: process.stdout by default. A false from write() waits for 'drain' when once() exists. */
export interface LineWriter {
  write(chunk: string): unknown;
  once?(event: 'drain', listener: () => void): unknown;
}

export interface BotIO {
  /** Harness lines; process.stdin by default. */
  input?: AsyncIterable<Uint8Array | string>;
  /** Replies; process.stdout by default. */
  output?: LineWriter;
}

export interface RunResult {
  state: LeanState;
  done: Done;
  /** Batches answered. */
  batches: number;
}

/**
 * Speak agent-fun/replay/v2 on stdin/stdout until done, then stop reading and resolve (the process
 * exits once stdout drains, even when the harness keeps stdin open). Rejects with ProtocolError,
 * OrderError or whatever a callback threw; unhandled, that ends the process with exit code 1.
 */
export async function runBot(bot: Bot, io: BotIO = {}): Promise<RunResult> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  let state: LeanState | null = null;
  let batches = 0;
  let lineNo = 0;
  for await (const line of readLines(input)) {
    lineNo++;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not JSON`);
    }
    const type = typeof msg === 'object' && msg !== null && !Array.isArray(msg) ? (msg as { type?: unknown }).type : undefined;
    if (type === 'hello') {
      const hello = msg as Hello;
      if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
      if (hello.protocol !== PROTOCOL) throw new ProtocolError(`the harness speaks ${describe(hello.protocol)}; this loop speaks ${PROTOCOL}`);
      state = new LeanState(hello);
      await bot.onHello?.(state as unknown as BotState);
    } else if (type === 'batch') {
      const batch = msg as Batch;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: a batch before hello`);
      checkBatch(batch, lineNo);
      state.applyBatch(batch);
      const orders = state.toOrders(await bot.onBatch(state as unknown as BotState, batch));
      const reply = { type: 'reply', seq: batch.seq, orders };
      const text = JSON.stringify(reply);
      if (text.length > MAX_BOT_LINE_BYTES) {
        throw new OrderError(`batch ${batch.seq}: the reply is ${text.length} bytes (max ${MAX_BOT_LINE_BYTES}); send fewer orders (caps.max_orders_per_batch is ${state.hello.caps.max_orders_per_batch})`);
      }
      state.recordOrders(orders);
      const ok = output.write(`${text}\n`);
      if (ok === false && typeof output.once === 'function') {
        await new Promise<void>((resolve) => {
          (output.once as (event: 'drain', listener: () => void) => unknown)('drain', resolve);
        });
      }
      batches++;
    } else if (type === 'done') {
      const done = msg as Done;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: done before hello`);
      state.applyDone(done);
      await bot.onDone?.(state as unknown as BotState, done);
      return { state, done, batches };
    } else {
      throw new ProtocolError(`input line ${lineNo}: unknown message type ${describe(type)}`);
    }
  }
  throw new ProtocolError(state === null ? 'input ended before hello' : `input ended before done (after ${batches} batches)`);
}

function checkBatch(batch: Batch, lineNo: number): void {
  const ok =
    Number.isSafeInteger(batch.seq) &&
    Number.isSafeInteger(batch.slot) &&
    Array.isArray(batch.events) &&
    Array.isArray(batch.marks) &&
    Array.isArray(batch.fills) &&
    typeof batch.account === 'object' &&
    batch.account !== null &&
    Array.isArray(batch.account.positions);
  if (!ok) throw new ProtocolError(`input line ${lineNo}: malformed batch`);
}
