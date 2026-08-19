const admin = require('firebase-admin');

// ============================================================
// CONFIGURACIÓN
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
  throw new Error('Falta FIREBASE_SERVICE_ACCOUNT');
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ============================================================
// FECHA ARGENTINA
// ============================================================

function getArgentinaDate() {
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

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day)
  };
}

// ============================================================
// HELPERS
// ============================================================

function absMonth(year, monthZeroBased) {
  return year * 12 + monthZeroBased;
}

function isActiveInMonth(item, year, monthZeroBased) {
  if (!item.desde) return true;

  const [dy, dm] = item.desde.split('-').map(Number);

  return absMonth(dy, dm - 1) <= absMonth(year, monthZeroBased);
}

function formatARS(value) {
  return 'ARS ' + Number(value || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function formatDate(year, month, day) {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function monthName(month) {
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

  return names[month - 1];
}

function addMonths(year, month, amount) {
  const d = new Date(year, month - 1 + amount, 1);

  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1
  };
}

// ============================================================
// FIREBASE - LISTAS GLOBALES
// ============================================================

async function getGlobalList(collectionName) {
  const snap = await db.collection(collectionName).get();

  return snap.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// ============================================================
// FIREBASE - ESTADO DEL MES
// ============================================================

async function getMonthDoc(collectionName, year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;

  const snap = await db
    .collection(collectionName)
    .doc(key)
    .get();

  return snap.exists ? snap.data() : {};
}

// ============================================================
// FIJOS
// ============================================================

async function getFixedReminders(today) {
  const [recurrentes, servicios, monthData] = await Promise.all([
    getGlobalList('fijos_rec'),
    getGlobalList('fijos_serv'),
    getMonthDoc('fijos_estado', today.year, today.month)
  ]);

  const all = [...recurrentes, ...servicios];

  const active = all.filter(item =>
    isActiveInMonth(item, today.year, today.month - 1)
  );

  const reminders = [];

  for (const fijo of active) {

    if (!fijo.dia) continue;

    const paid = monthData[fijo.id + '_paid'] || false;

    // Si ya está pagado, no avisamos.
    if (paid) continue;

    const diff = fijo.dia - today.day;

    // Solamente mañana o hoy.
    if (diff !== 0 && diff !== 1) continue;

    reminders.push({
      nombre: fijo.nombre || 'Sin nombre',
      dia: fijo.dia,
      tipo: diff === 0 ? 'HOY' : 'MAÑANA'
    });
  }

  return reminders;
}

// ============================================================
// ALQUILERES
// ============================================================

function getNextIncrease(rental, today) {

  if (!rental.inicio) return null;

  const frequency = Number(rental.auFreq || 3);

  const [startYear, startMonth] =
    rental.inicio.split('-').map(Number);

  const startAbs =
    absMonth(startYear, startMonth - 1);

  const nowAbs =
    absMonth(today.year, today.month - 1);

  const diff = nowAbs - startAbs;

  const nextIncreaseOffset =
    Math.ceil((diff + 1) / frequency) * frequency;

  const nextAbs =
    startAbs + nextIncreaseOffset;

  const nextYear =
    Math.floor(nextAbs / 12);

  const nextMonth =
    (nextAbs % 12) + 1;

  return {
    year: nextYear,
    month: nextMonth
  };
}

function getContractExpiration(rental) {

  if (!rental.inicio) return null;

  const duration =
    Number(rental.duracion || 24);

  const [startYear, startMonth] =
    rental.inicio.split('-').map(Number);

  const startAbs =
    absMonth(startYear, startMonth - 1);

  const endAbs =
    startAbs + duration;

  const year =
    Math.floor(endAbs / 12);

  const month =
    (endAbs % 12) + 1;

  return {
    year,
    month
  };
}

async function getRentalReminders(today) {

  const rentals =
    await getGlobalList('alquileres');

  const active = rentals.filter(rental =>
    isActiveInMonth(
      rental,
      today.year,
      today.month - 1
    )
  );

  if (!active.length) {
    return [];
  }

  const nextMonth = addMonths(
    today.year,
    today.month,
    1
  );

  const reminders = [];

  for (const rental of active) {

    const increase =
      getNextIncrease(rental, today);

    const expiration =
      getContractExpiration(rental);

    const increaseThisMonth =
      increase &&
      increase.year === today.year &&
      increase.month === today.month;

    const increaseNextMonth =
      increase &&
      increase.year === nextMonth.year &&
      increase.month === nextMonth.month;

    const expirationThisMonth =
      expiration &&
      expiration.year === today.year &&
      expiration.month === today.month;

    const expirationNextMonth =
      expiration &&
      expiration.year === nextMonth.year &&
      expiration.month === nextMonth.month;

    reminders.push({
      nombre: rental.desc || 'Alquiler',
      monto: rental.amt || 0,
      frecuencia: rental.auFreq || 3,
      aumento: increase,
      vencimiento: expiration,
      aumentoEsteMes: increaseThisMonth,
      aumentoProximoMes: increaseNextMonth,
      vencimientoEsteMes: expirationThisMonth,
      vencimientoProximoMes: expirationNextMonth
    });
  }

  return reminders;
}

// ============================================================
// CONSTRUCCIÓN DEL MAIL
// ============================================================

function buildEmail(fijos, alquileres, today) {

  const sections = [];

  // ----------------------------------------------------------
  // FIJOS
  // ----------------------------------------------------------

  if (fijos.length) {

    const hoy = fijos.filter(f => f.tipo === 'HOY');
    const manana = fijos.filter(f => f.tipo === 'MAÑANA');

    let html = `
      <h2>🔄 Gastos fijos</h2>
    `;

    if (hoy.length) {
      html += `
        <h3>🔴 Vencen hoy</h3>
        <ul>
      `;

      for (const item of hoy) {
        html += `
          <li>
            <strong>${item.nombre}</strong>
            — vence hoy (${item.dia}/${today.month})
          </li>
        `;
      }

      html += '</ul>';
    }

    if (manana.length) {
      html += `
        <h3>🟠 Vencen mañana</h3>
        <ul>
      `;

      for (const item of manana) {
        html += `
          <li>
            <strong>${item.nombre}</strong>
            — vence mañana (${item.dia}/${today.month})
          </li>
        `;
      }

      html += '</ul>';
    }

    sections.push(html);
  }

  // ----------------------------------------------------------
  // ALQUILERES
  // ----------------------------------------------------------

  if (alquileres.length && today.day === 1) {

    let html = `
      <h2>🏠 Alquileres — ${monthName(today.month)} ${today.year}</h2>
    `;

    for (const rental of alquileres) {

      html += `
        <div style="
          margin-bottom:18px;
          padding:12px;
          border:1px solid #ddd;
          border-radius:8px;
        ">
          <strong>${rental.nombre}</strong><br>
          Monto actual: <strong>${formatARS(rental.monto)}</strong><br>
          Frecuencia de aumento: cada ${rental.frecuencia} mes(es)
      `;

      if (rental.aumentoEsteMes) {
        html += `
          <br><strong>⚠️ ESTE MES CORRESPONDE AUMENTO</strong>
        `;
      } else if (rental.aumento) {
        html += `
          <br>Próximo aumento:
          <strong>
            ${monthName(rental.aumento.month)}
            ${rental.aumento.year}
          </strong>
        `;
      }

      if (rental.aumentoProximoMes) {
        html += `
          <br>📌 <strong>El próximo mes corresponde aumento.</strong>
        `;
      }

      if (rental.vencimientoEsteMes) {
        html += `
          <br><strong>🚨 ESTE MES VENCE EL CONTRATO</strong>
        `;
      } else if (rental.vencimiento) {
        html += `
          <br>Vencimiento del contrato:
          <strong>
            ${monthName(rental.vencimiento.month)}
            ${rental.vencimiento.year}
          </strong>
        `;
      }

      if (rental.vencimientoProximoMes) {
        html += `
          <br>📌 <strong>El próximo mes vence el contrato.</strong>
        `;
      }

      html += '</div>';
    }

    sections.push(html);
  }

  if (!sections.length) {
    return null;
  }

  const subjectParts = [];

  if (fijos.length) {
    subjectParts.push('vencimientos');
  }

  if (alquileres.length && today.day === 1) {
    subjectParts.push('alquileres');
  }

  const subject =
    `💰 Presupuesto Niquivan — ${subjectParts.join(' y ')}`;

  const body = `
    <div style="
      font-family:Arial,sans-serif;
      max-width:650px;
      margin:auto;
      color:#222;
    ">

      <h1>💰 Presupuesto Niquivan</h1>

      <p>
        Recordatorio del
        <strong>${formatDate(today.year, today.month, today.day)}</strong>.
      </p>

      ${sections.join('<hr style="margin:25px 0;">')}

      <hr style="margin-top:30px;">

      <p style="color:#777;font-size:12px;">
        Este mensaje fue generado automáticamente por
        Presupuesto Niquivan.
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

  const response = await fetch(
    'https://api.emailjs.com/api/v1.0/email/send',
    {
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
          subject: subject,
          message: body,
          html_message: body
        }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `EmailJS error (${response.status}): ${text}`
    );
  }

  console.log(`Mail enviado correctamente a ${toEmail}`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {

  const today = getArgentinaDate();

  console.log(
    `Hoy: ${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`
  );

  const fijos =
    await getFixedReminders(today);

  const alquileres =
    await getRentalReminders(today);

  console.log(`Fijos para avisar: ${fijos.length}`);

  if (today.day === 1) {
    console.log(`Alquileres: ${alquileres.length}`);
  } else {
    console.log('Hoy no corresponde resumen mensual de alquileres.');
  }

  const email =
    buildEmail(fijos, alquileres, today);

  if (!email) {
    console.log(
      'No hay recordatorios para enviar. No se enviará ningún mail.'
    );
    return;
  }

  const recipients = [
    TO_EMAIL_1,
    TO_EMAIL_2
  ].filter(Boolean);

  if (!recipients.length) {
    throw new Error(
      'No hay destinatarios configurados.'
    );
  }

  for (const recipient of recipients) {
    try {
      await sendEmail(
        recipient,
        email.subject,
        email.body
      );
    } catch (error) {
      console.error(
        `Error al enviar mail a ${recipient}:`,
        error.message
      );
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
