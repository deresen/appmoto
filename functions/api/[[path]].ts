interface Env {
  APPMOTO_API?: { fetch(request: Request): Promise<Response> };
}

function unavailable(): Response {
  return new Response(JSON.stringify({
    error: "Il servizio delle segnalazioni non è disponibile. Riprova tra poco.",
  }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const service = context.env?.APPMOTO_API;
  if (typeof service?.fetch !== "function") return unavailable();
  try {
    // The service binding keeps the Pages URL and origin, cookies, body and
    // WebSocket upgrade intact. The existing Worker remains authoritative.
    return await service.fetch(context.request);
  } catch {
    return unavailable();
  }
}
