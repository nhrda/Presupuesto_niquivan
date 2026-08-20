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
  const tomorrow = getArgentinaDate(1);
  const todayKey = today.dateStr;

  console.log(`Ejecutando para: ${todayKey}`);

  // 1. IDEMPOTENCIA: Evitar mails duplicados en el mismo día
  const sendRef = db.collection('email_reminder_sends').doc(todayKey);
  const sendDoc = await sendRef.get();
  if (sendDoc.exists) {
    console.log('Ya se enviaron recordatorios hoy. Salteando ejecución.');
    return;
  }

  // 2. Obtener datos de Firestore
  const fijosRecSnap = await db.collection('fijos_rec').get();
  const fijosServSnap = await db.collection('fijos_serv').get();
  // El estado mensual se guarda con clave YYYY-MM
  const mesActual = todayKey.slice(0, 7); 
  const fijosEstadoSnap = await db.collection('fijos_estado').doc(mesActual).get();
  const alquileresSnap = await db.collection('alquileres').get();

  const fijosEstado = fijosEstadoSnap.exists ? fijosEstadoSnap.data() : {};
  const fijos = [...fijosRecSnap.docs, ...fijosServSnap.docs].map(d => ({ id: d.id, ...d.data() }));
  const alquileres = alquileresSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 3. Procesar Fijos
  const fijosHoy = [];
  const fijosManana = [];

  for (const f of fijos) {
    if (fijosEstado[`${f.id}_paid`]) continue; // Ya está marcado como pagado
    const dia = Number(f.dia);
    if (dia === Number(today.d)) fijosHoy.push(f);
    if (dia === Number(tomorrow.d)) fijosManana.push(f);
  }

  // 4. Procesar Alquileres
  const alquileresAumentoEsteMes = [];
  const alquileresFinEsteMes = [];
  const alquileresFinUnMesAntes = [];

  for (const a of alquileres) {
    // A) Lógica de Aumento (basada en inicio + auFreq)
    if (a.inicio && a.auFreq) {
      const [startY, startM] = a.inicio.split('-').map(Number);
      const startAbs = startY * 12 + (startM - 1);
      const currentAbs = today.y * 12 + (Number(today.m) - 1);
      const diff = currentAbs - startAbs;
      const freq = Number(a.auFreq);
      
      if (diff >= 0 && diff % freq === 0 && today.d === '01') {
        alquileresAumentoEsteMes.push(a);
      }
    }

    // B) Lógica de Finalización
    if (a.finContrato) {
      // Fecha exacta definida (YYYY-MM-DD)
      const unMesAntes = addMonths(a.finContrato, -1);
      
      if (a.finContrato.startsWith(`${today.y}-${today.m}`) && today.d === '01') {
        alquileresFinEsteMes.push({ ...a, tipo: 'exacto' });
      }
      if (unMesAntes === today.dateStr) {
        alquileresFinUnMesAntes.push({ ...a, tipo: 'exacto' });
      }
    } else if (a.inicio && a.duracion) {
      // Fallback: cálculo por mes si no hay fecha exacta
      const [startY, startM] = a.inicio.split('-').map(Number);
      const duracion = Number(a.duracion);
      const endAbs = (startY * 12 + (startM - 1)) + duracion;
      const endY = Math.floor(endAbs / 12);
      const endM = String((endAbs % 12) + 1).padStart(2, '0');
      
      if (`${endY}-${endM}` === `${today.y}-${today.m}` && today.d === '01') {
        alquileresFinEsteMes.push({ ...a, tipo: 'estimado' });
      }
    }
  }

  // 5. Decidir si hay algo que avisar
  const hayAvisos = fijosHoy.length > 0 || fijosManana.length > 0 || 
                    alquileresAumentoEsteMes.length > 0 || 
                    alquileresFinEsteMes.length > 0 || 
                    alquileresFinUnMesAntes.length > 0;

  if (!hayAvisos) {
    console.log('No hay avisos relevantes para hoy. No se envía mail.');
    return;
  }

  // 6. Marcar como enviado ANTES de mandar el mail (garantía de idempotencia)
  await sendRef.set({ 
    sentAt: new Date().toISOString(), 
    resumen: `Fijos: ${fijosHoy.length + fijosManana.length}, Alquileres: ${alquileresAumentoEsteMes.length + alquileresFinEsteMes.length + alquileresFinUnMesAntes.length}` 
  });

  // 7. Construir el HTML del mail
  let html = `<h2 style="color:#051721; font-family: Arial, sans-serif;">💰 Presupuesto Niquivan - Recordatorios</h2>`;
  
  if (fijosHoy.length > 0) {
    html += `<h3 style="color:#d32f2f;">🔴 Vencen HOY (${formatDate(today.dateStr)})</h3><ul>`;
    fijosHoy.forEach(f => html += `<li><strong>${f.nombre}</strong> (Día ${f.dia})</li>`);
    html += `</ul>`;
  }

  if (fijosManana.length > 0) {
    html += `<h3 style="color:#f57c00;">🟠 Vencen MAÑANA (${formatDate(tomorrow.dateStr)})</h3><ul>`;
    fijosManana.forEach(f => html += `<li><strong>${f.nombre}</strong> (Día ${f.dia})</li>`);
    html += `</ul>`;
  }

  if (alquileresAumentoEsteMes.length > 0 && today.d === '01') {
    html += `<h3 style="color:#1976d2;">🏠 Alquileres: Aumento/Renovación este mes</h3><ul>`;
    alquileresAumentoEsteMes.forEach(a => html += `<li><strong>${a.desc}</strong></li>`);
    html += `</ul>`;
  }

  if (alquileresFinUnMesAntes.length > 0) {
    html += `<h3 style="color:#7b1fa2;">⚠️ Alquileres: Finaliza contrato en 1 mes</h3><ul>`;
    alquileresFinUnMesAntes.forEach(a => html += `<li><strong>${a.desc}</strong> (${a.finContrato ? formatDate(a.finContrato) : 'Mes estimado'})</li>`);
    html += `</ul>`;
  }

  if (alquileresFinEsteMes.length > 0 && today.d === '01') {
    html += `<h3 style="color:#c2185b;">🚨 Alquileres: Finaliza contrato ESTE mes</h3><ul>`;
    alquileresFinEsteMes.forEach(a => html += `<li><strong>${a.desc}</strong> (${a.finContrato ? formatDate(a.finContrato) : 'Mes estimado'})</li>`);
    html += `</ul>`;
  }

  // 8. Enviar Email vía EmailJS
  const destinatarios = [process.env.EMAILJS_TO_EMAIL_1, process.env.EMAILJS_TO_EMAIL_2].filter(e => e && e.trim() !== '');
  
  for (const email of destinatarios) {
    const payload = {
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: email,
        subject: `💰 Niquivan: Recordatorios ${formatDate(today.dateStr)}`,
        html_message: html
      }
    };

    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log(`Mail enviado correctamente a ${email}`);
    } else {
      console.error(`Error EmailJS para ${email}:`, await res.text());
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
