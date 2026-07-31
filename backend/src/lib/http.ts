export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 500, code?: string): Response {
  return jsonResponse(code ? { error: message, code } : { error: message }, status);
}
