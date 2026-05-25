// Minimal Cloudflare Pages Functions types. Hand-defined to avoid pulling in
// @cloudflare/workers-types (smaller supply-chain surface). Expand only as the
// surface needs more.

export {};

declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    get(key: string, type: "text"): Promise<string | null>;
    get<T = unknown>(key: string, type: "json"): Promise<T | null>;
    get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
    put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView,
      options?: { expirationTtl?: number },
    ): Promise<void>;
    delete(key: string): Promise<void>;
  }

  type EventContext<Env, Params extends string = string> = {
    request: Request;
    env: Env;
    params: Record<Params, string>;
    waitUntil: (promise: Promise<unknown>) => void;
    next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  };

  type PagesFunction<Env = unknown, Params extends string = string> = (
    context: EventContext<Env, Params>,
  ) => Response | Promise<Response>;
}

// Binding surface available to every PagesFunction in this project.
export interface Env {
  PACK_KV: KVNamespace;
  DAILY_DEV_API_TOKEN: string;
  GH_OPERATOR_PAT?: string;
  // CF Pages built-in fetcher for static assets in public/.
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}
