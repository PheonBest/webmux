export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 500, code?: string, blockingBranch?: string): Response {
  return jsonResponse(
    { error: message, ...(code ? { code } : {}), ...(blockingBranch ? { blockingBranch } : {}) },
    status,
  );
}
