// server.js — Gms Trader (Railway/Vercel)
import express from "express";
import bodyParser from "body-parser";
import { startBot, stopBot } from "./bot.js";

const app = express();
app.use(bodyParser.json());

// ====== PÁGINA PRINCIPAL ======
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Gms Trader - Login Deriv</title>
      <style>
        body { font-family: Arial; text-align: center; margin-top: 100px; }
        a { background: #e00; color: white; padding: 12px 20px; border-radius: 6px; text-decoration: none; }
        a:hover { background: #c00; }
      </style>
    </head>
    <body>
      <h1>🤖 Gms Trader</h1>
      <p>Clique abaixo para conectar-se com sua conta Deriv:</p>
      <a href="/api/login">Entrar com Deriv</a>
    </body>
    </html>
  `);
});

// ====== LOGIN VIA OAUTH DERIV ======
app.get("/api/login", (req, res) => {
  const app_id = process.env.DERIV_APP_ID || "109178";
  const redirect_uri = process.env.REDIRECT_URI || "https://gms-trader.vercel.app/api/callback";

  const loginUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${app_id}&redirect_uri=${encodeURIComponent(redirect_uri)}`;
  res.redirect(loginUrl);
});

// ====== CALLBACK DO OAUTH ======
app.get("/api/callback", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("❌ Token ausente.");

  try {
    await startBot(token);
    res.send("✅ Bot iniciado com sucesso! Pode fechar esta aba.");
  } catch (e) {
    console.error("Erro ao iniciar bot:", e);
    res.status(500).send("❌ Erro ao iniciar o bot.");
  }
});

// ====== INICIAR E PARAR BOT MANUALMENTE ======
app.post("/api/start-bot", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).send("❌ Token ausente.");
  try {
    await startBot(token);
    res.send("✅ Bot iniciado com sucesso!");
  } catch (e) {
    console.error(e);
    res.status(500).send("❌ Erro ao iniciar bot.");
  }
});

app.post("/api/stop-bot", async (req, res) => {
  try {
    await stopBot();
    res.send("⏹ Bot parado com sucesso!");
  } catch (e) {
    console.error(e);
    res.status(500).send("❌ Erro ao parar bot.");
  }
});

// ====== PORTA DO SERVIDOR ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gms Trader rodando na porta ${PORT}`));
