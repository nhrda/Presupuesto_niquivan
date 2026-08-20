const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ============================================================
// CONFIGURACIÓN GENERAL
// ============================================================

const TIMEZONE = 'America/Argentina/Buenos_Aires';

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

const TO_EMAIL_1 = process.env.EMAILJS_TO_EMAIL_1;
const TO_EMAIL_2 = process.env.EMAILJS_TO_EMAIL_2;

// ============================================================
// FIREBASE
// ============================================================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('Falta configurar el secret FIREBASE_SERVICE_ACCOUNT');
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// ============================================================
// FECHAS ARGENTINA
// ============================================================

function getArgentinaDate(offsetDays = 0) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const result = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }
  }

  const base = new Date(
    Number(result.year),
    Number(result.month) - 1,
    Number(result.day)
  );

  base.setDate(base.getDate() + offsetDays);

  const year = base.getFullYear();
  const month = base.getMonth() + 1;
  const day = base.getDate();

  return {
    year,
    month,
    day,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    monthKey: `${year}-${String(month).padStart(2, '0')}`
  };
}

function formatDate(dateKey) {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

function formatMonth(year, month) {
  const names = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre'
  ];

  return `${names[month - 1]} ${year}`;
}

function formatARS(value) {
  return 'ARS ' + Number(value || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function absMonth(year, month) {
  // month = 1 a 12
  return year * 12 + (month - 1);
}

function lastDayOfMonth(year, month) {
  // month = 1 a 12
  return new Date(year, month, 0).getDate();
}

function subtractOneMonth(dateKey) {
  // Recibe YYYY-MM-DD y devuelve YYYY-MM-DD, cuidando meses cortos.
  const [year, month, day] = dateKey.split('-').map(Number);

  let newYear = year;
  let newMonth = month - 1;

  if (newMonth === 0) {
    newMonth = 12;
    newYear -= 1;
  }

  const maxDay = lastDayOfMonth(newYear, newMonth);
  const newDay = Math.min(day, maxDay);

  return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(newDay).padStart(2, '0')}`;
}

function isActiveInMonth(item, year, month) {
  // month = 1 a 12
  if (!item.desde) return true;

  const [desdeYear, desdeMonth] = String(item.desde).split('-').map(Number);

  if (!desdeYear || !desdeMonth) return true;

  return absMonth(desdeYear, desdeMonth) <= absMonth(year, month);
}

// ============================================================
// FIRESTORE HELPERS
// ============================================================

async function getGlobalList(collectionName) {
  const snap = await db.collection(collectionName).get();

  return snap.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

async function getMonthDoc(collectionName, monthKey) {
  const snap = await db.collection(collectionName).doc(monthKey).get();
  return snap.exists ? snap.data() : {};
}

// ============================================================
// IDEMPOTENCIA
// Evita que GitHub Actions o una prueba manual envíen 2 veces
// el mismo mail en el mismo día.
// ============================================================

async function acquireSendLock(dateKey, summary) {
  const ref = db.collection('email_reminder_sends').doc(dateKey);

  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);

    if (snap.exists) {
      return false;
    }

    transaction.set(ref, {
      status: 'sending',
      createdAt: new Date().toISOString(),
      dateKey,
      summary
    });

    return true;
  });
}

async function markSendResult(dateKey, status, extra = {}) {
  const ref = db.collection('email_reminder_sends').doc(dateKey);

  await ref.set(
    {
      status,
      updatedAt: new Date().toISOString(),
      ...extra
    },
    { merge: true }
  );
}

// ============================================================
// FIJOS
// ============================================================

async function getFixedReminders(today, tomorrow) {
  const [recurrentes, servicios, estadoHoy, estadoManana] = await Promise.all([
    getGlobalList('fijos_rec'),
    getGlobalList('fijos_serv'),
    getMonthDoc('fijos_estado', today.monthKey),
    getMonthDoc('fijos_estado', tomorrow.monthKey)
  ]);

  const all = [...recurrentes, ...servicios];

  const fijosHoy = [];
  const fijosManana = [];

  for (const fijo of all) {
    const dia = Number(fijo.dia);

    if (!dia) continue;

    // Aviso de hoy
    if (
      dia === today.day &&
      isActiveInMonth(fijo, today.year, today.month) &&
      !estadoHoy[`${fijo.id}_paid`]
    ) {
      fijosHoy.push({
        id: fijo.id,
        nombre: fijo.nombre || 'Sin nombre',
        dia,
        amt:
          estadoHoy[`${fijo.id}_amt`] !== undefined
            ? estadoHoy[`${fijo.id}_amt`]
            : fijo.amt || 0
      });
    }

    // Aviso de mañana
    if (
      dia === tomorrow.day &&
      isActiveInMonth(fijo, tomorrow.year, tomorrow.month) &&
      !estadoManana[`${fijo.id}_paid`]
    ) {
      fijosManana.push({
        id: fijo.id,
        nombre: fijo.nombre || 'Sin nombre',
        dia,
        amt:
          estadoManana[`${fijo.id}_amt`] !== undefined
            ? estadoManana[`${fijo.id}_amt`]
            : fijo.amt || 0
      });
    }
  }

  fijosHoy.sort((a, b) => a.dia - b.dia || a.nombre.localeCompare(b.nombre));
  fijosManana.sort((a, b) => a.dia - b.dia || a.nombre.localeCompare(b.nombre));

  return {
    fijosHoy,
    fijosManana
  };
}

// ============================================================
// ALQUILERES
// ============================================================

function getIncreaseReminder(alquiler, today) {
  if (today.day !== 1) return null;
  if (!alquiler.inicio) return null;

  const frequency = Number(alquiler.auFreq || 0);

  if (!frequency) return null;

  const [startYear, startMonth] = String(alquiler.inicio)
    .split('-')
    .map(Number);

  if (!startYear || !startMonth) return null;

  const startAbs = absMonth(startYear, startMonth);
  const currentAbs = absMonth(today.year, today.month);
  const diff = currentAbs - startAbs;

  // Importante:
  // diff > 0 evita avisar aumento en el mismo mes de inicio.
  // Ejemplo: inicio 2026-01, auFreq 3 -> avisa 2026-04, 2026-07, etc.
  if (diff > 0 && diff % frequency === 0) {
    return {
      nombre: alquiler.desc || 'Alquiler',
      amt: alquiler.amt || 0,
      inicio: alquiler.inicio,
      auFreq: frequency
    };
  }

  return null;
}

function getContractEndReminders(alquiler, today) {
  const reminders = {
    finUnMesAntes: null,
    finEsteMes: null
  };

  // Caso 1: fecha exacta opcional YYYY-MM-DD
  if (alquiler.finContrato) {
    const finContrato = String(alquiler.finContrato);
    const oneMonthBefore = subtractOneMonth(finContrato);
    const contractMonthKey = finContrato.slice(0, 7);

    if (oneMonthBefore === today.dateKey) {
      reminders.finUnMesAntes = {
        nombre: alquiler.desc || 'Alquiler',
        amt: alquiler.amt || 0,
        finContrato,
        tipo: 'exacto'
      };
    }

    if (today.day === 1 && contractMonthKey === today.monthKey) {
      reminders.finEsteMes = {
        nombre: alquiler.desc || 'Alquiler',
        amt: alquiler.amt || 0,
        finContrato,
        tipo: 'exacto'
      };
    }

    return reminders;
  }

  // Caso 2: fallback por mes usando inicio + duracion.
  // No inventamos un día exacto.
  if (today.day !== 1) return reminders;
  if (!alquiler.inicio || !alquiler.duracion) return reminders;

  const [startYear, startMonth] = String(alquiler.inicio)
    .split('-')
    .map(Number);

  const duration = Number(alquiler.duracion || 0);

  if (!startYear || !startMonth || !duration) return reminders;

  const endAbs = absMonth(startYear, startMonth) + duration;
  const endYear = Math.floor(endAbs / 12);
  const endMonth = (endAbs % 12) + 1;
  const endMonthKey = `${endYear}-${String(endMonth).padStart(2, '0')}`;

  if (endMonthKey === today.monthKey) {
    reminders.finEsteMes = {
      nombre: alquiler.desc || 'Alquiler',
      amt: alquiler.amt || 0,
      finContrato: null,
      estimatedMonth: endMonthKey,
      tipo: 'estimado'
    };
  }

  return reminders;
}

async function getRentalReminders(today) {
  const alquileres = await getGlobalList('alquileres');

  const active = alquileres.filter(alquiler =>
    isActiveInMonth(alquiler, today.year, today.month)
  );

  const aumentosEsteMes = [];
  const contratosUnMesAntes = [];
  const contratosEsteMes = [];

  for (const alquiler of active) {
    const aumento = getIncreaseReminder(alquiler, today);

    if (aumento) {
      aumentosEsteMes.push(aumento);
    }

    const fin = getContractEndReminders(alquiler, today);

    if (fin.finUnMesAntes) {
      contratosUnMesAntes.push(fin.finUnMesAntes);
    }

    if (fin.finEsteMes) {
      contratosEsteMes.push(fin.finEsteMes);
    }
  }

  return {
    aumentosEsteMes,
    contratosUnMesAntes,
    contratosEsteMes
  };
}

// ============================================================
// EMAIL HTML
// ============================================================

function buildEmail({ today, tomorrow, fijosHoy, fijosManana, aumentosEsteMes, contratosUnMesAntes, contratosEsteMes }) {
  const sections = [];

  if (fijosHoy.length) {
    let html = `
      <h2 style="color:#d32f2f;">🔴 Gastos fijos que vencen HOY</h2>
      <p>Fecha: <strong>${formatDate(today.dateKey)}</strong></p>
      <ul>
    `;

    for (const fijo of fijosHoy) {
      html += `
        <li>
          <strong>${fijo.nombre}</strong>
          ${fijo.amt ? ` — ${formatARS(fijo.amt)}` : ''}
          — vence día ${fijo.dia}
        </li>
      `;
    }

    html += '</ul>';

    sections.push(html);
  }

  if (fijosManana.length) {
    let html = `
      <h2 style="color:#f57c00;">🟠 Gastos fijos que vencen MAÑANA</h2>
      <p>Fecha: <strong>${formatDate(tomorrow.dateKey)}</strong></p>
      <ul>
    `;

    for (const fijo of fijosManana) {
      html += `
        <li>
          <strong>${fijo.nombre}</strong>
          ${fijo.amt ? ` — ${formatARS(fijo.amt)}` : ''}
          — vence día ${fijo.dia}
        </li>
      `;
    }

    html += '</ul>';

    sections.push(html);
  }

  if (aumentosEsteMes.length) {
    let html = `
      <h2 style="color:#1976d2;">🏠 Alquileres con aumento / renovación este mes</h2>
      <p>Mes: <strong>${formatMonth(today.year, today.month)}</strong></p>
      <ul>
    `;

    for (const alquiler of aumentosEsteMes) {
      html += `
        <li>
          <strong>${alquiler.nombre}</strong>
          ${alquiler.amt ? ` — monto actual: ${formatARS(alquiler.amt)}` : ''}
          — frecuencia: cada ${alquiler.auFreq} mes(es)
        </li>
      `;
    }

    html += '</ul>';

    sections.push(html);
  }

  if (contratosUnMesAntes.length) {
    let html = `
      <h2 style="color:#7b1fa2;">⚠️ Alquileres: contrato finaliza en 1 mes</h2>
      <ul>
    `;

    for (const alquiler of contratosUnMesAntes) {
      html += `
        <li>
          <strong>${alquiler.nombre}</strong>
          ${alquiler.amt ? ` — ${formatARS(alquiler.amt)}` : ''}
          — finaliza el <strong>${formatDate(alquiler.finContrato)}</strong>
        </li>
      `;
    }

    html += '</ul>';

    sections.push(html);
  }

  if (contratosEsteMes.length) {
    let html = `
      <h2 style="color:#c2185b;">🚨 Alquileres: contrato finaliza ESTE mes</h2>
      <p>Mes: <strong>${formatMonth(today.year, today.month)}</strong></p>
      <ul>
    `;

    for (const alquiler of contratosEsteMes) {
      if (alquiler.tipo === 'exacto') {
        html += `
          <li>
            <strong>${alquiler.nombre}</strong>
            ${alquiler.amt ? ` — ${formatARS(alquiler.amt)}` : ''}
            — finaliza el <strong>${formatDate(alquiler.finContrato)}</strong>
          </li>
        `;
      } else {
        html += `
          <li>
            <strong>${alquiler.nombre}</strong>
            ${alquiler.amt ? ` — ${formatARS(alquiler.amt)}` : ''}
            — finalización estimada durante este mes
          </li>
        `;
      }
    }

    html += '</ul>';

    sections.push(html);
  }

  if (!sections.length) {
    return null;
  }

  const subjectParts = [];

  if (fijosHoy.length || fijosManana.length) {
    subjectParts.push('vencimientos');
  }

  if (aumentosEsteMes.length || contratosUnMesAntes.length || contratosEsteMes.length) {
    subjectParts.push('alquileres');
  }

  const subject = `💰 Presupuesto Niquivan — ${subjectParts.join(' y ')}`;

  const body = `
    <div style="
      font-family: Arial, sans-serif;
      max-width: 680px;
      margin: auto;
      color: #222;
      line-height: 1.45;
    ">
      <h1 style="color:#051721;">💰 Presupuesto Niquivan</h1>

      <p>
        Recordatorio automático del
        <strong>${formatDate(today.dateKey)}</strong>.
      </p>

      ${sections.join('<hr style="margin:25px 0;border:none;border-top:1px solid #ddd;">')}

      <hr style="margin-top:30px;border:none;border-top:1px solid #ddd;">

      <p style="color:#777;font-size:12px;">
        Este mensaje fue generado automáticamente por Presupuesto Niquivan.
      </p>
    </div>
  `;

  return {
    subject,
    body
  };
}

// ============================================================
// EMAILJS
// ============================================================

async function sendEmail(toEmail, subject, body) {
  if (!toEmail) return;

  if (!EMAILJS_SERVICE_ID) throw new Error('Falta EMAILJS_SERVICE_ID');
  if (!EMAILJS_TEMPLATE_ID) throw new Error('Falta EMAILJS_TEMPLATE_ID');
  if (!EMAILJS_PUBLIC_KEY) throw new Error('Falta EMAILJS_PUBLIC_KEY');
  if (!EMAILJS_PRIVATE_KEY) throw new Error('Falta EMAILJS_PRIVATE_KEY');

  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: toEmail,
        subject,
        message: body,
        html_message: body,
        message_html: body
      }
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`EmailJS error (${response.status}): ${text}`);
  }

  console.log(`Mail enviado correctamente a ${toEmail}`);
  console.log(`Respuesta EmailJS: ${text}`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const today = getArgentinaDate(0);
  const tomorrow = getArgentinaDate(1);

  console.log(`Hoy Argentina: ${today.dateKey}`);
  console.log(`Mañana Argentina: ${tomorrow.dateKey}`);

  const recipients = [TO_EMAIL_1, TO_EMAIL_2].filter(email => email && email.trim() !== '');

  if (!recipients.length) {
    console.log('No hay destinatarios configurados. No se enviará ningún mail.');
    return;
  }

  const [{ fijosHoy, fijosManana }, { aumentosEsteMes, contratosUnMesAntes, contratosEsteMes }] =
    await Promise.all([
      getFixedReminders(today, tomorrow),
      getRentalReminders(today)
    ]);

  console.log(`Fijos hoy: ${fijosHoy.length}`);
  console.log(`Fijos mañana: ${fijosManana.length}`);
  console.log(`Alquileres con aumento este mes: ${aumentosEsteMes.length}`);
  console.log(`Contratos que finalizan en 1 mes: ${contratosUnMesAntes.length}`);
  console.log(`Contratos que finalizan este mes: ${contratosEsteMes.length}`);

  const email = buildEmail({
    today,
    tomorrow,
    fijosHoy,
    fijosManana,
    aumentosEsteMes,
    contratosUnMesAntes,
    contratosEsteMes
  });

  if (!email) {
    console.log('No hay avisos para enviar hoy.');
    return;
  }

  const summary = {
    fijosHoy: fijosHoy.length,
    fijosManana: fijosManana.length,
    aumentosEsteMes: aumentosEsteMes.length,
    contratosUnMesAntes: contratosUnMesAntes.length,
    contratosEsteMes: contratosEsteMes.length,
    recipients
  };

  const lockAcquired = await acquireSendLock(today.dateKey, summary);

  if (!lockAcquired) {
    console.log('Ya existe un envío registrado para hoy. No se enviará otro mail.');
    return;
  }

  const results = [];

  for (const recipient of recipients) {
    try {
      await sendEmail(recipient, email.subject, email.body);

      results.push({
        email: recipient,
        ok: true
      });
    } catch (error) {
      console.error(`Error enviando a ${recipient}:`, error.message);

      results.push({
        email: recipient,
        ok: false,
        error: error.message
      });
    }
  }

  const anySuccess = results.some(result => result.ok);
  const finalStatus = anySuccess ? 'sent' : 'failed';

  await markSendResult(today.dateKey, finalStatus, {
    sentAt: new Date().toISOString(),
    results
  });

  console.log(`Proceso finalizado con estado: ${finalStatus}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
