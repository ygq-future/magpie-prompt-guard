// The bridge magpie serves beside every page (page/_magpie/bridge.js).
// Only what this page calls is declared here.

interface MagpieOptionsApi {
  get(): Promise<unknown>;
  set(options: unknown): Promise<unknown>;
}

interface MagpieBridge {
  ready: Promise<unknown>;
  options: MagpieOptionsApi;
  read(name: string, params?: Record<string, unknown>): Promise<unknown>;
}

declare const magpie: MagpieBridge | undefined;

// page/rules.js publishes the shipped list on the global object so the page
// (classic script) and the middleware (side-effect import) share one list.
declare var PROMPT_GUARD_RULES:
  | Array<{ on: boolean; find: string; replace: string; mode: "text" | "regex" }>
  | undefined;
