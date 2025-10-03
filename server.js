import express from "express";
import fetch from "node-fetch";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

// ---------- Firebase Admin ----------
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  // Caso Render (pegas el JSON en variable)
  const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(creds) });
} else {
  // Caso local con ruta al archivo (GOOGLE_APPLICATION_CREDENTIALS apunta al .json)
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

// ---------- Config ----------
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "PAB";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // Meta
const WA_TOKEN = process.env.WHATSAPP_TOKEN;                  // Meta
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;       // Tú lo inventas

// ---------- Helpers ----------
function parseMessage(text) {
  const raw = (text || "").trim();
  const normalized = raw.replace(",", ".").toLowerCase();
  const tokens = normalized.split(/\s+/);
  let lugarTokens = [];
  let monto = null;
  let moneda = null;

  for (const t of tokens) {
    if (monto === null && /^-?\d+(\.\d+)?$/.test(t)) { monto = parseFloat(t); continue; }
    if (!moneda && /^[a-z]{3}$/.test(t)) { moneda = t.toUpperCase(); continue; }
    lugarTokens.push(t);
  }

  return {
    lugar: lugarTokens.join(" ").trim(),
    monto: isNaN(monto) ? null : monto,
    moneda: (moneda || DEFAULT_CURRENCY).toUpperCase(),
    raw
  };
}

function calcularQuincena(date) {
  return date.getDate() <= 15 ? 1 : 2;
}

async function sendWhatsAppText(toWaId, message) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: toWaId,
    text: { body: message }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    console.error("Error enviando WhatsApp:", await res.text());
  }
}

// ---------- Webhook verification (GET) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---------- Webhook receiver (POST) ----------
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (msg?.from) {
      const from = msg.from;                // waId del usuario
      const text = msg.text?.body?.trim();  // texto del mensaje

      if (!text) {
        await sendWhatsAppText(from, "Envíame el gasto como: 'lugar monto' (ej: 'super 23.50')");
        return res.sendStatus(200);
      }

      const parsed = parseMessage(text);
      if (!parsed.lugar || parsed.monto === null) {
        await sendWhatsAppText(from, "Formato inválido. Ej: 'uber 8' o 'farmacia 12,30' (moneda opcional: '5 USD').");
        return res.sendStatus(200);
      }

      const now = new Date(); // fecha automática del servidor
      const gasto = {
        fechaServidor: admin.firestore.Timestamp.fromDate(now),
        lugar: parsed.lugar,
        monto: parsed.monto,
        moneda: parsed.moneda,
        userWaId: from,
        raw: parsed.raw,
        fuente: "whatsapp",
        year: now.getFullYear(),
        mes: now.getMonth() + 1,
        dia: now.getDate(),
        quincena: calcularQuincena(now),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection("gastos").add(gasto);

      const montoFmt = parsed.monto.toLocaleString("es-PA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await sendWhatsAppText(from, `✅ Guardado: ${parsed.lugar} – ${montoFmt} ${parsed.moneda}`);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Error webhook:", e);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ejecutándose en puerto ${PORT}`));
