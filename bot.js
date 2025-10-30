// bot.js - adapted full bot for Railway environment
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
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { console.warn('config.json não encontrado ou inválido. Usando defaults.'); }

const DEFAULTS = {
  app_id: config.app_id || 'YOUR_APP_ID',
  api_token: '',
  market: config.market || 'R_50 (1s)',
  initial_stake: config.initial_stake || 0.35,
  stake_after_win: config.stake_after_win || 0.35,
  martingale_factor: config.martingale_factor || 2.2,
  duration: config.duration || 1,
  duration_unit: config.duration_unit || 't',
  prediction: config.prediction || 4,
  virtual_loss_limit: config.virtual_loss_limit || 2,
  meta: config.meta || 100,
  stop_loss: config.stop_loss || 10999,
  currency: config.currency || 'USD',
  cooldown_seconds: config.cooldown_seconds || 2,
  reconnect_base_ms: config.reconnect_base_ms || 2000,
  reconnect_max_ms: config.reconnect_max_ms || 60000
};

export const cfg = { ...DEFAULTS, ...(config || {}) };

export let state = {
  initial_balance: null,
  last_balance: null,
  daily_pnl: 0,
  virtual_loss_counter: 0,
  current_stake: cfg.initial_stake,
  trades_today: 0,
  last_trade_time: 0,
  last_result: 'N/A',
  last_price: null
};

if (fs.existsSync(STATE_FILE)) {
  try { const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); Object.assign(state, raw); } catch (e) { console.error('Erro ao carregar state:', e); }
}

function appendTradeLog(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}\n`;
  try { fs.appendFileSync(TRADE_LOG, out); } catch (e) { console.warn('Falha ao gravar log:', e.message || e); }
  console.log(out.trim());
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('Falha ao salvar state:', e.message || e); }
}

function readControl() {
  try { const raw = fs.readFileSync(CONTROL_FILE, 'utf8'); const c = JSON.parse(raw); return !!c.run; } catch { return true; }
}

let ws = null;
let reconnectMs = cfg.reconnect_base_ms;
let shouldStop = false;
const pendingRequests = new Map();
let clientIdCounter = 1;
function makeClientId() { return `c${Date.now()}_${clientIdCounter++}`; }

function sendRequest(wsocket, payload, timeout = 10000) {
  if (!wsocket || wsocket.readyState !== WebSocket.OPEN) {
    appendTradeLog('❌ Conecte-se primeiro à Deriv!');
    return Promise.reject(new Error('WebSocket não conectado'));
  }

  return new Promise((resolve, reject) => {
    const client_id = makeClientId();
    payload.passthrough = { client_id };
    pendingRequests.set(client_id, { resolve, reject, timer: null });

    try { wsocket.send(JSON.stringify(payload)); } catch (e) { pendingRequests.delete(client_id); return reject(e); }

    const timer = setTimeout(() => {
      if (pendingRequests.has(client_id)) { pendingRequests.delete(client_id); reject(new Error('Timeout na resposta API')); }
    }, timeout);

    pendingRequests.set(client_id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      timer
    });
  });
}

function routeIncomingMessage(msg) {
  try {
    const pt = msg.passthrough;
    if (pt && pt.client_id) {
      const pending = pendingRequests.get(pt.client_id);
      if (pending && typeof pending.resolve === 'function') {
        pending.resolve(msg);
        pendingRequests.delete(pt.client_id);
        return true;
      }
    }
  } catch (e) { console.error('routeIncomingMessage erro:', e); }
  return false;
}

function canTrade() {
  if (!readControl()) return false;
  const now = Date.now();
  if (now - (state.last_trade_time || 0) < cfg.cooldown_seconds * 1000) return false;
  const initial = state.initial_balance || 0;
  const pnl = (state.last_balance ?? initial) - initial;
  if (cfg.meta && pnl >= cfg.meta) { appendTradeLog(`🎯 META atingida (PNL=${pnl.toFixed(2)} ≥ ${cfg.meta}) — pausando.`); stopBot(); return false; }
  if (cfg.stop_loss && pnl <= -Math.abs(cfg.stop_loss)) { appendTradeLog(`🛑 STOP-LOSS atingido (PNL=${pnl.toFixed(2)} ≤ -${cfg.stop_loss}) — pausando.`); stopBot(); return false; }
  return true;
}

async function waitContractResult(wsocket, contract_id, pollInterval = 1000) {
  while (true) {
    const resp = await sendRequest(wsocket, { proposal_open_contract: 1, contract_id }, 10000).catch(() => null);
    if (!resp) { await new Promise(r => setTimeout(r, pollInterval)); continue; }
    const data = resp.proposal_open_contract || resp;
    if (data && (data.is_sold === true || data.is_sold === 1)) {
      const profit = typeof data.profit !== 'undefined' ? Number(data.profit) : (Number(data.sell_price || 0) - Number(data.buy_price || 0));
      return { profit };
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
}

async function processTick(tick) {
  try {
    const price = Number(tick.quote);
    const lastDigit = Math.floor(price) % 10;
    state.last_price = price;
    saveState();
    if (lastDigit <= cfg.prediction) state.virtual_loss_counter++; else state.virtual_loss_counter = 0;
    if (state.virtual_loss_counter > cfg.virtual_loss_limit) { appendTradeLog(`Contador perda virtual (${state.virtual_loss_counter}) acima do limite (${cfg.virtual_loss_limit}). Reiniciando contador.`); state.virtual_loss_counter = 0; saveState(); }
    if (!canTrade()) return;
    const lastResult = state.last_result || 'N/A';
    let stake = state.current_stake || cfg.initial_stake;
    if (lastResult === 'LOSS') stake = stake * cfg.martingale_factor; else stake = cfg.initial_stake;
    stake = parseFloat(stake.toFixed(2));
    state.current_stake = stake;
    saveState();
    appendTradeLog(`[TICK] lastDigit=${lastDigit} | stake=${stake} | lastResult=${lastResult}`);
    if (state.last_balance && stake > state.last_balance * 0.9) { appendTradeLog(`⚠️ Stake (${stake}) muito alto para o saldo (${state.last_balance}). Resetando para stake inicial.`); state.current_stake = cfg.initial_stake; saveState(); return; }
    const proposalResp = await sendRequest(ws, { proposal: 1, amount: stake, basis: 'stake', contract_type: 'DIGITOVER', currency: cfg.currency, duration: cfg.duration, duration_unit: cfg.duration_unit, symbol: cfg.market, barrier: cfg.prediction }).catch((e) => ({ error: e.message || 'timeout' }));
    if (proposalResp.error) { appendTradeLog(`ERRO proposta: ${proposalResp.error}`); return; }
    const buyResp = await sendRequest(ws, { buy: proposalResp.proposal.id, price: stake }).catch((e) => ({ error: e.message || 'timeout' }));
    if (buyResp.error) { appendTradeLog(`ERRO compra: ${buyResp.error}`); return; }
    const contrato = buyResp.buy.contract_id;
    appendTradeLog(`🟢 Contrato comprado — ID=${contrato}, stake=${stake}`);
    const result = await waitContractResult(ws, contrato);
    const lucro = result.profit;
    state.last_result = lucro > 0 ? 'WIN' : 'LOSS';
    state.last_trade_time = Date.now();
    state.trades_today = (state.trades_today || 0) + 1;
    appendTradeLog(`💰 Resultado: ${state.last_result} | Lucro=${lucro}`);
    saveState();
  } catch (e) { appendTradeLog(`ERRO em processTick: ${e && e.message ? e.message : e}`); }
}

export async function startBot(tokenOverride = null) {
  const token = tokenOverride || cfg.api_token;
  if (!cfg.app_id || !token || token.startsWith('YOUR_')) { appendTradeLog('⚠️ Faça login com a Deriv antes de iniciar o bot.'); return; }
  if (ws && ws.readyState === WebSocket.OPEN) { appendTradeLog('Fechando conexão anterior antes de iniciar nova sessão...'); try { ws.close(); } catch {} ws = null; }
  shouldStop = false;
  reconnectMs = cfg.reconnect_base_ms;
  ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${cfg.app_id}`);
  ws.on('open', () => { appendTradeLog(`Conectando à Deriv (${cfg.market})...`); ws.send(JSON.stringify({ authorize: token })); });
  ws.on('message', async (raw) => { let msg; try { msg = JSON.parse(raw); } catch { return; } if (routeIncomingMessage(msg)) return; if (msg.authorize) { const bal = Number(msg.authorize.balance); state.last_balance = bal; if (!state.initial_balance) state.initial_balance = bal; appendTradeLog(`✅ Autorizado — Saldo: ${bal}`); saveState(); try { ws.send(JSON.stringify({ ticks: cfg.market })); } catch {} try { ws.send(JSON.stringify({ balance: 1, subscribe: 1 })); } catch {} return; } if (msg.balance) { const bal = Number(msg.balance.balance); if (!isNaN(bal)) { state.last_balance = bal; saveState(); } return; } if (msg.tick) { if (shouldStop) return; processTick(msg.tick).catch((e) => appendTradeLog(`ERRO process tick: ${e && e.message ? e.message : e}`)); } });
  ws.on('close', () => { appendTradeLog('🔌 Conexão fechada.'); for (const [k, v] of pendingRequests.entries()) { try { if (v && typeof v.reject === 'function') v.reject(new Error('Conexão fechada')); } catch {} pendingRequests.delete(k); } ws = null; if (!shouldStop) { appendTradeLog('Tentando reconectar automaticamente...'); setTimeout(() => { reconnectMs = Math.min(cfg.reconnect_max_ms, reconnectMs * 1.5); startBot(token).catch((e) => appendTradeLog(`Erro reconectando: ${e && e.message ? e.message : e}`)); }, reconnectMs); } });
  ws.on('error', (err) => { appendTradeLog(err && err.message ? err.message : err); });
  setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN && !shouldStop) { try { ws.send(JSON.stringify({ ticks: cfg.market })); } catch (e) { } } }, cfg.cooldown_seconds * 1000);
}

export async function stopBot() {
  shouldStop = true;
  if (ws) { try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) { appendTradeLog(`⚠️ Erro ao fechar WebSocket: ${e.message}`); } ws = null; }
  appendTradeLog('⏹ Bot parado (stopBot()).'); saveState();
}

setInterval(saveState, 15000);
