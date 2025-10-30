// server.js
import express from "express";
import bodyParser from "body-parser";
import { startBot, stopBot, getStatus } from "./bot.js";

const app = express();
app.use(bodyParser.json());

app.get("/", (req,res) => res.send("🤖 Gms Trader Bot ativo no Railway"));

app.post("/api/start-bot", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).send("Token ausente.");
  try {
    await startBot(token);
    return res.send({ status: "started" });
  } catch (err) {
    console.error("start-bot error:", err);
    return res.status(500).send({ error: "falha ao iniciar bot" });
  }
});

app.post("/api/stop-bot", async (req, res) => {
  await stopBot();
  res.send({ status: "stopped" });
});

app.get("/api/status", (req, res) => {
  res.send(getStatus());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gms Trader rodando na porta ${PORT}`));
