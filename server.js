import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import twilio from "twilio";

const app = express();

/**
 * Twilio Sandbox envía los mensajes como application/x-www-form-urlencoded.
 * bodyParser.urlencoded es necesario para leer req.body.Body, req.body.From, etc.
 */
app.use(bodyParser.urlencoded({ extended: false }));

/* ----------------------- Firebase Admin (Firestore) ----------------------- */
// Opción recomendada en Render: pegar el JSON en GOOGLE_APPLICATION_CREDENTIALS_JSON
let adminInitialized = false;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  adminInitialized = true;
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  // Opción local: apunta a la ruta del archivo .json
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  adminInitialized = true;
}
if (!adminInitialized) {
  throw new Error(
    "No hay credenciales de Firebase. Define GOOGLE_APPLICATION_CREDENTIALS_JSON (contenido) o GOOGLE_APPLICATION_CREDENTIALS (ruta)."
  );
}

const db = admin.firestore();

/* ---------------------------- Configuración app --------------------------- */
const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || "PAB").toUpperCase();

// Twilio (Sandbox o número habilitado para WhatsApp)
const TWILIO_SID = process.env.TWILIO_SID;          // ACxxxxxxxx
const TWILIO_AUTH = process.env.TWILIO_AUTH;        // token
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;    // ej: +14155238886 (sandbox)
if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_NUMBER) {
  console.warn("⚠️ Faltan variables de Twilio (TWILIO_SID/TWILIO_AUTH/TWILIO_NUMBER).");
}
const client = twilio(TWILIO_SID, TWILIO_AUTH);

/* --------------------------------- Helpers -------------------------------- */
function parseMessage(text) {
  const raw = (text || "").trim();
  if (!raw) return { raw, lugar: null, monto: null, moneda: DEFAULT_CURRENCY };

  // Normaliza coma decimal y divide en tokens
  const normalized = raw.replace(",", ".").toLowerCase();
  const tokens = normalized.split(/\s+/);

  let lugarTokens = [];
  let monto = null;
  let moneda = null;

  for (const t of tokens) {
    if (monto === null && /^-?\d+(\.\d+)?$/.test(t)) {
      monto = parseFloat(t);
      continue;
    }
    if (!moneda && /^[a-z]{3}$/.test(t)) {
      moneda = t.toUpperCase();
      continue;
    }
    lugarTokens.push(t);
  }

  return {
    raw,
    lugar: lugarTokens.join(" ").trim() || null,
    monto: isNaN(monto) ? null : monto,
    moneda: (moneda || DEFAULT_CURRENCY).toUpperCase(),
  };
}

function quincena(date) {
  return date.getDate() <= 15 ? 1 : 2;
}

async function replyWhatsApp(to, body) {
  // twilio exige prefijo whatsapp:
  return client.messages.create({
    from: `whatsapp:${TWILIO_NUMBER}`,
    to, // ya viene con "whatsapp:+507..." desde Twilio en req.body.From
    body
  });
}

/* -------------------------------- Endpoints ------------------------------- */
// Salud/diagnóstico
app.get("/", (_req, res) => res.status(200).send("OK - wa-gastos-bot-twilio"));
app.post("/status", (req, res) => {
  // Si configuras Status Callback, Twilio pegará aquí eventos de entrega/lectura
  console.log("Status callback:", req.body);
  res.sendStatus(200);
});

// Webhook de Twilio (WhatsApp Sandbox -> tu servidor)
app.post("/webhook", async (req, res) => {
  try {
    const from = req.body.From;   // ej: "whatsapp:+5076XXXXXXX"
    const body = req.body.Body;   // texto del mensaje

    if (!from) {
      return res.sendStatus(200); // nada que procesar
    }

    // Parseo del mensaje
    const parsed = parseMessage(body);
    if (!parsed.lugar || parsed.monto === null) {
      await replyWhatsApp(from, "Formato inválido. Usa: 'lugar monto' (ej: super 23.50). Moneda opcional: '5 USD'.");
      return res.sendStatus(200);
    }

    // Fecha automática (servidor)
    const now = new Date();
    const gasto = {
      fechaServidor: admin.firestore.Timestamp.fromDate(now),
      lugar: parsed.lugar,
      monto: parsed.monto,
      moneda: parsed.moneda,
      userWaId: from, // número del remitente con prefijo whatsapp:
      raw: parsed.raw,
      fuente: "whatsapp-twilio",
      year: now.getFullYear(),
      mes: now.getMonth() + 1,
      dia: now.getDate(),
      quincena: quincena(now),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("gastos").add(gasto);

    const montoFmt = parsed.monto.toLocaleString("es-PA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await replyWhatsApp(from, `✅ Guardado: ${parsed.lugar} – ${montoFmt} ${parsed.moneda}`);

    res.sendStatus(200);
  } catch (err) {
    console.error("Error en /webhook:", err);
    res.sendStatus(500);
  }
});

/* --------------------------------- Server --------------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`WA Gastos (Twilio) escuchando en :${PORT}`));
