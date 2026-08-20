const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const TIMEZONE = 'America/Argentina/Buenos_Aires';

function getArgentinaDate(offsetDays = 0) {
  const now = new Date();
  const arg = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  arg.setDate(arg.getDate() + offsetDays);
  const y = arg.getFullYear();
  const m = String(arg.getMonth() + 1).padStart(2, '0');
  const d = String(arg.getDate()).padStart(2, '0');
  return { dateStr: `${y}-${m}-${d}`, y, m, d };
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() + months);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const nd = String(date.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

async function main() {
  const today = getArgentinaDate(0);
  const todayKey = today.dateStr;

  console.log(`Ejecutando para: ${todayKey}`);

  // IDEMPOTENCIA
  const sendRef = db.collection('email_reminder_sends').doc(todayKey);
  const sendDoc = await sendRef.get();
  if (sendDoc.exists) {
    console.log('Ya se enviaron recordatorios hoy.');
    return;
  }

  // OBTENER DATOS
  const mesActual = todayKey.slice(0, 7);
  const [fijosRecSnap, fijosServSnap, fijosEstadoSnap, alquileresSnap] = await Promise.all([
    db.collection('fijos_rec').get(),
    db.collection('fijos_serv').get(),
    db.collection('fijos_estado').doc(mesActual).get(),
    db.collection('alquileres').get()
  ]);

  const fijosEstado = fijosEstadoSnap.exists ? fijosEstadoSnap.data() : {};
  const fijos = [...fijosRecSnap.docs, ...fijosServSnap.docs].map(d => ({ id: d.id, ...d.data() }));
  const alquileres = alquileresSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // FIJOS
  const fijosHoy = [];
  const fijosManana = [];
  for (const f of fijos) {
    if (fijosEstado[`${f.id}_paid`]) continue;
    const dia = Number(f.dia);
    if (dia === Number(today.d)) fijosHoy.push(f);
    if (dia === Number(today.d) + 1 || (dia === 1 && Number(today.d) === 31)) fijosManana.push(f);
  }

  // ALQUILERES
  const alquileresAumento = [];
  const alquileresFinUnMesAntes = [];
  const alquileresFinEsteMes = [];

  for (const a of alquileres) {
    // Aumentos
    if (a.inicio && a.auFreq && today.d === '01') {
      const [startY, startM] = a.inicio.split('-').map(Number);
      const startAbs = startY * 12 + (startM - 1);
      const currentAbs = today.y * 12 + (Number(today.m) - 1);
      const diff = currentAbs - startAbs;
      if (diff >= 0 && diff % Number(a.auFreq) === 0) {
        alquileresAumento.push(a);
      }
    }

    // Finalización
    if (a.finContrato) {
      const unMesAntes = addMonths(a.finContrato, -1);
      if (unMesAntes === todayKey) alquileresFinUnMesAntes.push(a);
      if (a.finContrato.startsWith(`${today.y}-${today.m}`) && today.d === '01') {
        alquileresFinEsteMes.push(a);
      }
    } else if (a.inicio && a.duracion && today.d === '01') {
      const [startY, startM] = a.inicio.split('-').map(Number);
      const endAbs = (startY * 12 + (startM - 1)) + Number(a.duracion);
      const endY = Math.floor(endAbs / 12);
      const endM = String((endAbs % 12) + 1).padStart(2, '0');
      if (`${endY}-${endM}` === `${today.y}-${today.m}`) {
        alquileresFinEsteMes.push(a);
      }
    }
  }

  // DECIDIR SI ENVÍAR
  if (!fijosHoy.length && !fijosManana.length && !alquileresAumento.length && !alquileresFinUnMesAntes.length && !alquileresFinEsteMes.length) {
    console.log('Sin avisos.');
    return;
  }

  // MARCAR COMO ENVIADO
  await sendRef.set({ sentAt: new Date().toISOString() });

  // ARMAR HTML
  let html = `<h2>💰 Niquivan - Recordatorios</h2>`;
  if (fijosHoy.length) {
    html += `<h3>🔴 HOY</h3><ul>`;
    fijosHoy.forEach(f => html += `<li>${f.nombre}</li>`);
    html += `</ul>`;
  }
  if (fijosManana.length) {
    html += `<h3> MAÑANA</h3><ul>`;
    fijosManana.forEach(f => html += `<li>${f.nombre}</li>`);
    html += `</ul>`;
  }
  if (alquileresAumento.length) {
    html += `<h3>🏠 AUMENTOS</h3><ul>`;
    alquileresAumento.forEach(a => html += `<li>${a.desc}</li>`);
    html += `</ul>`;
  }
  if (alquileresFinUnMesAntes.length) {
    html += `<h3>⚠️ FINALIZA EN 1 MES</h3><ul>`;
    alquileresFinUnMesAntes.forEach(a => html += `<li>${a.desc}</li>`);
    html += `</ul>`;
  }
  if (alquileresFinEsteMes.length) {
    html += `<h3>🚨 FINALIZA ESTE MES</h3><ul>`;
    alquileresFinEsteMes.forEach(a => html += `<li>${a.desc}</li>`);
    html += `</ul>`;
  }

  // ENVIAR EMAIL
  const destinatarios = [process.env.EMAILJS_TO_EMAIL_1, process.env.EMAILJS_TO_EMAIL_2].filter(e => e);
  for (const email of destinatarios) {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: process.env.EMAILJS_TEMPLATE_ID,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: { to_email: email, subject: 'Niquivan - Recordatorios', html_message: html }
      })
    });
    if (res.ok) console.log(`Enviado a ${email}`);
  }
}

main().catch(console.error);
