const BREVO_CONTACTS = 'https://api.brevo.com/v3/contacts';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}

/** Evita comillas/espacios al pegar la clave en Vercel */
function normalizeApiKey(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function isDuplicateError(status, data, msg) {
  const code = data && data.code ? String(data.code) : '';
  const m = (msg || '').toLowerCase();
  return (
    status === 400 &&
    (code === 'duplicate_parameter' ||
      /duplicate|already exist|ya existe|contact already/i.test(m))
  );
}

/**
 * Mensaje en español según respuesta Brevo (para que puedas corregir sin adivinar).
 */
function mapBrevoError(status, data, rawText) {
  const msg = data && data.message != null ? String(data.message) : '';
  const text = (rawText || '').toString();
  const full = `${msg} ${text}`.trim();

  if (status === 401 || status === 403) {
    return 'La clave API no es válida o no tiene permisos. Revisa BREVO_API_KEY en Vercel (Production) y en Brevo → SMTP & API → API keys.';
  }

  if (status === 402 || status === 429) {
    return 'Límite de tu cuenta Brevo alcanzado. Revisa tu plan o cuotas.';
  }

  if (status === 400) {
    if (isDuplicateError(status, data, msg)) {
      return null;
    }
    if (/list|listids|list_id|invalid.*id|document_not_found/i.test(full)) {
      return 'El ID de lista no existe en esta cuenta Brevo. Comprueba el número en Contacts → Lists y BREVO_LIST_ID en Vercel.';
    }
    if (/invalid.*email|email.*invalid|wrong.*email/i.test(full)) {
      return 'Correo no aceptado por Brevo.';
    }
    if (msg) {
      const short = msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
      return `Brevo: ${short}`;
    }
  }

  if (status >= 500) {
    return 'Brevo no respondió bien. Inténtalo más tarde.';
  }

  return 'No se pudo completar. Inténtalo de nuevo.';
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method === 'GET') {
      const key = normalizeApiKey(process.env.BREVO_API_KEY);
      return json({
        ok: true,
        brevoConfigured: Boolean(key),
        listId: Number(process.env.BREVO_LIST_ID || '6'),
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido' }, 405);
    }

    const apiKey = normalizeApiKey(process.env.BREVO_API_KEY);
    const listId = Number(process.env.BREVO_LIST_ID || '6');

    if (!apiKey) {
      console.error('BREVO_API_KEY no está definida');
      return json({ error: 'Servicio no configurado' }, 500);
    }

    if (!Number.isFinite(listId) || listId < 1) {
      return json({ error: 'Servicio no configurado' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Petición no válida' }, 400);
    }

    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Introduce un correo válido' }, 400);
    }

    try {
      const r = await fetch(BREVO_CONTACTS, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          listIds: [listId],
          updateEnabled: true,
        }),
      });

      const text = await r.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }

      if (r.ok) {
        return json({ ok: true });
      }

      const msg = data.message != null ? String(data.message) : '';
      if (isDuplicateError(r.status, data, msg)) {
        return json({ ok: true, duplicate: true });
      }

      const mapped = mapBrevoError(r.status, data, text);
      if (mapped === null) {
        return json({ ok: true, duplicate: true });
      }

      console.error('Brevo error', r.status, text);

      const clientStatus =
        r.status === 401 || r.status === 403
          ? r.status
          : r.status === 400
            ? 400
            : 502;

      return json(
        {
          error: mapped,
          brevoStatus: r.status,
          brevoCode: data.code || null,
        },
        clientStatus
      );
    } catch (err) {
      console.error(err);
      return json(
        {
          error:
            'Error de conexión con Brevo. Si persiste, revisa los logs en Vercel.',
        },
        502
      );
    }
  },
};
