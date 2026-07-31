import { initClient, type InitClientArgs } from "@ts-rest/core";
import { apiContract } from "./contract";

export type ApiClientOptions = Omit<InitClientArgs, "baseUrl">;

export function createApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  return initClient(apiContract, {
    baseUrl,
    throwOnUnknownStatus: true,
    baseHeaders: {},
    ...options,
  });
}

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

type SuccessBody<TResponse> = Extract<TResponse, { status: SuccessStatus }> extends { body: infer TBody }
  ? TBody
  : never;

type UnwrappedClient<TClient> = {
  [K in keyof TClient]: TClient[K] extends (...args: infer TArgs) => Promise<infer TResponse>
    ? (...args: TArgs) => Promise<SuccessBody<TResponse>>
    : TClient[K];
};

type RouteCall = (...args: unknown[]) => Promise<unknown>;
type RouteResponse = { status: number; body: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRouteResponse(value: unknown): value is RouteResponse {
  return isRecord(value)
    && "status" in value
    && typeof value.status === "number"
    && "body" in value;
}

/** Thrown for any non-2xx API response. `code`, when present, is a
 *  machine-readable error code (e.g. "direct_switch_dirty") the server
 *  attached so callers can branch on a specific failure instead of
 *  string-matching `message` — see ErrorResponseSchema. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function unwrapResponse(response: unknown): unknown {
  if (!isRouteResponse(response)) {
    throw new Error("Malformed API client response");
  }
  if (response.status < 200 || response.status >= 300) {
    const { message, code } = errorDetailsFromResponse(response.body, response.status);
    throw new ApiError(message, response.status, code);
  }
  return response.body;
}

function errorDetailsFromResponse(body: unknown, status: number): { message: string; code?: string } {
  if (typeof body === "string") {
    try {
      return errorDetailsFromResponse(JSON.parse(body) as unknown, status);
    } catch {
      return { message: body.trim() || `HTTP ${status}` };
    }
  }
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    const code = "code" in body && typeof body.code === "string" ? body.code : undefined;
    return { message: body.error, ...(code ? { code } : {}) };
  }
  return { message: `HTTP ${status}` };
}

// ts-rest interpolates path params verbatim, so names like `feature/foo`
// must be encoded before they are inserted into `/api/.../:name/...`.
function withEncodedPathParams(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  if (!first || typeof first !== "object" || !("params" in first) || !first.params || typeof first.params !== "object") {
    return args;
  }

  const encodedParams = Object.fromEntries(
    Object.entries(first.params).map(([key, value]) => [key, encodeURIComponent(String(value))]),
  );

  return [
    {
      ...first,
      params: encodedParams,
    },
    ...rest,
  ];
}

function wrapRouteCall(routeCall: RouteCall): RouteCall {
  return async (...args: unknown[]) => unwrapResponse(await routeCall(...withEncodedPathParams(args)));
}

function wrapClient<TClient extends Record<string, unknown>>(client: TClient): UnwrappedClient<TClient> {
  return Object.fromEntries(
    Object.entries(client).map(([key, value]) => {
      if (typeof value === "function") {
        return [key, wrapRouteCall((...args) => Promise.resolve(Reflect.apply(value, undefined, args)))];
      }
      if (isRecord(value)) {
        return [key, wrapClient(value)];
      }
      return [key, value];
    }),
  ) as UnwrappedClient<TClient>;
}

export function createApi(baseUrl: string, options: ApiClientOptions = {}): UnwrappedClient<ReturnType<typeof createApiClient>> {
  return wrapClient(createApiClient(baseUrl, options));
}
