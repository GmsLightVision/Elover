// bot.js — Gms Trader (versão completa e compatível com Railway OAuth)
import fs from "fs";
import path from "path";
import WebSocket from "ws";

const CONFIG_FILE = "./config.json";
const CONTROL_FILE = "./control.json";
const STATE_FILE = "./state.json";
const LOGS_DIR = "./logs";
const TRADE_LOG = path.join(LOGS_DIR, "trades.log");

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch {
  console.warn("⚠️ config.json não encontrado. Usando valores padrão.");
}

// ====== CONFIGURAÇÕES PADRÃO ======
const DEFAULTS = {
  app_id: process.env.DERIV_APP_ID || "1089",
  market: "R_50 (1s)",
  initial_stake: 0.35,
  stake_after_win: 0.35,
  martingale_factor: 2.2,
  duration: 1,
  duration_unit: "t",
  prediction: 4,
  virtual_loss_limit: 2,
  meta: 100,
  stop_loss: 100,
  currency: "USD",
  cooldown_seconds: 2,
  reconnect_base_ms: 2000,
  reconnect_max_ms: 60000,
};

export const cfg = { ...DEFAULTS, ...config };

// ====== ESTADO DO BOT ======
export let state = {
  initial_balance: null,
  last_balance: null,
  daily_pnl: 0,
  virtual_loss_counter: 0,
  current_stake: cfg.initial_stake,
  trades_today: 0,
  last_trade_time: 0,
  last_result: "N/A",
  last_price: null,
};

if (fs.existsSync(STATE_FILE)) {
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch (e) {
    console.error("Erro ao carregar state.json:", e.message);
  }
}

// ====== FUNÇÕES DE LOG E SALVAMENTO ======
function appendTradeLog(line) {
  const ts = new Date().toISOString();
  const log = `[${ts}] ${line}\n`;
  fs.appendFileSync(TRADE_LOG, log);
  console.log(log.trim());
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readControl() {
  try {
    return !!JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8")).run;
  } catch {
    return true;
  }
}

// ====== CONTROLE DE CONEXÃO ======
let ws = null;
let shouldStop = false;
let reconnectMs = cfg.reconnect_base_ms;
let pendingRequests = new Map();
let clientId = 0;

function makeClientId() {
  return `c${Date.now()}_${++clientId}`;
}

function sendRequest(socket, payload, timeout = 10000) {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error("WebSocket não conectado"));

  return new Promise((resolve, reject) => {
    const id = makeClientId();
    payload.passthrough = { id };
    pendingRequests.set(id, { resolve, reject });

    socket.send(JSON.stringify(payload));

    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Timeout na resposta API"));
      }
    }, timeout);

    pendingRequests.get(id).timer = timer;
  });
}

function routeIncomingMessage(msg) {
  const pt = msg.passthrough;
  if (pt?.id && pendingRequests.has(pt.id)) {
    const pending = pendingRequests.get(pt.id);
    pending.resolve(msg);
    clearTimeout(pending.timer);
    pendingRequests.delete(pt.id);
    return true;
  }
  return false;
}

// ====== LÓGICA DE TRADING ======
function canTrade() {
  if (!readControl()) return false;

  const now = Date.now();
  if (now - (state.last_trade_time || 0) < cfg.cooldown_seconds * 1000) return false;

  const pnl = (state.last_balance ?? 0) - (state.initial_balance ?? 0);
  if (cfg.meta && pnl >= cfg.meta) {
    appendTradeLog(`🎯 META atingida (PNL=${pnl.toFixed(2)} ≥ ${cfg.meta}) — pausando.`);
    stopBot();
    return false;
  }

  if (cfg.stop_loss && pnl <= -Math.abs(cfg.stop_loss)) {
    appendTradeLog(`🛑 STOP-LOSS atingido (PNL=${pnl.toFixed(2)} ≤ -${cfg.stop_loss}) — pausando.`);
    stopBot();
    return false;
  }

  return true;
}

async function waitContractResult(socket, contract_id, pollInterval = 1000) {
  while (true) {
    const resp = await sendRequest(socket, { proposal_open_contract: 1, contract_id }).catch(() => null);
    const data = resp?.proposal_open_contract;
    if (data?.is_sold) {
      const profit = Number(data.profit ?? (data.sell_price - data.buy_price));
      return { profit };
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

async function processTick(tick) {
  try {
    const price = Number(tick.quote);
    const lastDigit = Math.floor(price) % 10;
    state.last_price = price;
    saveState();

    if (lastDigit <= cfg.prediction) state.virtual_loss_counter++;
    else state.virtual_loss_counter = 0;

    if (!canTrade()) return;

    let stake = state.last_result === "LOSS"
      ? state.current_stake * cfg.martingale_factor
      : cfg.initial_stake;

    stake = parseFloat(stake.toFixed(2));
    state.current_stake = stake;

    appendTradeLog(`[TICK] lastDigit=${lastDigit} | stake=${stake}`);

    if (state.last_balance && stake > state.last_balance * 0.9) {
      appendTradeLog(`⚠️ Stake (${stake}) muito alto — resetando.`);
      state.current_stake = cfg.initial_stake;
      saveState();
      return;
    }

    const proposal = await sendRequest(ws, {
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: "DIGITOVER",
      currency: cfg.currency,
      duration: cfg.duration,
      duration_unit: cfg.duration_unit,
      symbol: cfg.market,
      barrier: cfg.prediction,
    }).catch(e => ({ error: e.message }));

    if (proposal.error) return appendTradeLog(`ERRO proposta: ${proposal.error}`);

    const buy = await sendRequest(ws, { buy: proposal.proposal.id, price: stake })
      .catch(e => ({ error: e.message }));

    if (buy.error) return appendTradeLog(`ERRO compra: ${buy.error}`);

    appendTradeLog(`🟢 Contrato comprado ID=${buy.buy.contract_id}, stake=${stake}`);

    const result = await waitContractResult(ws, buy.buy.contract_id);
    const lucro = result.profit;

    state.last_result = lucro > 0 ? "WIN" : "LOSS";
    state.last_trade_time = Date.now();
    state.trades_today++;
    state.last_balance += lucro;
    appendTradeLog(`💰 ${state.last_result} | Lucro=${lucro.toFixed(2)} | Balanço=${state.last_balance.toFixed(2)}`);

    saveState();
  } catch (e) {
    appendTradeLog(`❌ ERRO em processTick: ${e.message}`);
  }
}

// ====== FUNÇÕES PÚBLICAS ======
export async function startBot(tokenOverride = null) {
  const token = tokenOverride;
  if (!cfg.app_id || !token) {
    appendTradeLog("⚠️ Token OAuth ausente. Faça login pela Deriv.");
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    appendTradeLog("Fechando conexão anterior...");
    ws.close();
  }

  shouldStop = false;
  reconnectMs = cfg.reconnect_base_ms;

  ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${cfg.app_id}`);

  ws.on("open", () => {
    appendTradeLog(`🌐 Conectando à Deriv (${cfg.market})...`);
    ws.send(JSON.stringify({ authorize: token }));
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (routeIncomingMessage(msg)) return;

    if (msg.authorize) {
      const bal = Number(msg.authorize.balance);
      state.last_balance = bal;
      if (!state.initial_balance) state.initial_balance = bal;
      appendTradeLog(`✅ Autorizado — Saldo: ${bal}`);
      ws.send(JSON.stringify({ ticks: cfg.market }));
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      saveState();
      return;
    }

    if (msg.tick && !shouldStop) processTick(msg.tick);
  });

  ws.on("close", () => {
    appendTradeLog("🔌 Conexão fechada.");
    ws = null;
    if (!shouldStop) {
      appendTradeLog("Tentando reconectar...");
      setTimeout(() => startBot(token), Math.min(cfg.reconnect_max_ms, reconnectMs *= 1.5));
    }
  });

  ws.on("error", (err) => appendTradeLog(`Erro WS: ${err.message}`));
}

export async function stopBot() {
  shouldStop = true;
  if (ws) ws.close();
  appendTradeLog("⏹ Bot parado manualmente.");
  saveState();
}
