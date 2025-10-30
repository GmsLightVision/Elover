import express from "express";
import bodyParser from "body-parser";
import { startBot, stopBot } from "./bot.js";

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => res.send("🤖 Gms Trader Bot ativo no Railway"));

app.post("/api/start-bot", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).send("Token ausente.");
  await startBot(token);
  res.send("Bot iniciado com sucesso!");
});

app.post("/api/stop-bot", async (req, res) => {
  await stopBot();
  res.send("Bot parado!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gms Trader rodando na porta ${PORT}`));
