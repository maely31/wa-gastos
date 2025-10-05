import express from "express";
import admin from "firebase-admin";

// ---------------- App ----------------
const app = express();
app.use(express.json()); // Meta envía JSON

// -------- Firebase Admin (igual que antes) --------
let ok = false;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  ok = true;
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  ok = true;
}
if (!ok) throw new Error("Faltan credenciales de Firebase.");
const db = admin.firestore();

// ------------- Config Meta -------------
const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || "USD").toUpperCase();
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

async function sendWhatsAppText(toWaId, message) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: toWaId,                // número destino E164 sin 'whatsapp:' (ej: "5076...")
    type: "text",
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
    const txt = await res.text();
    console.error("Meta send error:", res.status, txt);
  }
}

// -------- Helpers (los mismos que ya usas) --------
function parseMessage(text) {
  const raw = (text || "").trim();
  if (!raw) return { raw, lugar: null, monto: null, moneda: DEFAULT_CURRENCY };
  const normalized = raw.replace(",", ".").toLowerCase();
  const tokens = normalized.split(/\s+/);
  let lugarTokens = [], monto = null, moneda = null;
  for (const t of tokens) {
    if (monto === null && /^-?\d+(\.\d+)?$/.test(t)) { monto = parseFloat(t); continue; }
    if (!moneda && /^[a-z]{3}$/.test(t)) { moneda = t.toUpperCase(); continue; }
    lugarTokens.push(t);
  }
  return {
    raw,
    lugar: lugarTokens.join(" ").trim() || null,
    monto: isNaN(monto) ? null : monto,
    moneda: (moneda || DEFAULT_CURRENCY).toUpperCase(),
  };
}
const quincena = d => (d.getDate() <= 15 ? 1 : 2);

// ---------------- Rutas ----------------
// Ping
app.get("/", (_req, res) => res.status(200).send("OK - wa-gastos (Meta)"));

// Webhook verification (GET) - requerido por Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Webhook (POST) - mensajes entrantes de WhatsApp Cloud API
app.post("/webhook", async (req, res) => {
  try {
    // Estructura: entry[0].changes[0].value.messages[0]
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200); // no-message events

    const fromWaId = msg.from;           // "5076...." (sin +, sin 'whatsapp:')
    const text = msg.text?.body?.trim(); // mensaje

    // Si envían botón/interactive, no tiene text; puedes manejarlo luego
    if (!text) {
      await sendWhatsAppText(fromWaId, "Envíame el gasto como: 'lugar monto' (ej: super 23.50 USD)");
      return res.sendStatus(200);
    }

    const parsed = parseMessage(text);
    if (!parsed.lugar || parsed.monto === null) {
      await sendWhatsAppText(fromWaId, "Formato inválido. Usa: 'lugar monto' (ej: farmacia 12,30). Moneda opcional: '5 USD'.");
      return res.sendStatus(200);
    }

    const now = new Date();
    await db.collection("gastos").add({
      fechaServidor: admin.firestore.Timestamp.fromDate(now),
      lugar: parsed.lugar,
      monto: parsed.monto,
      moneda: parsed.moneda,
      userWaId: fromWaId,
      raw: parsed.raw,
      fuente: "whatsapp-cloud",
      year: now.getFullYear(),
      mes: now.getMonth() + 1,
      dia: now.getDate(),
      quincena: quincena(now),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const montoFmt = parsed.monto.toLocaleString("es-PA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await sendWhatsAppText(fromWaId, `✅ Guardado: ${parsed.lugar} – ${montoFmt} ${parsed.moneda}`);

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200); // 200 para que Meta no reintente en bucle
  }
});

// -------------- Server --------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("WA Gastos (Meta) escuchando en :", PORT));
