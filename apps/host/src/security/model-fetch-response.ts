// Normalizes injected fetch seams without losing native Response prototype methods.
type ResponseReader = { read(): Promise<{ value?: Uint8Array; done?: boolean }> };
type InjectedModelResponse = {
  ok: boolean;
  status: number;
  body?: { getReader(): ResponseReader } | null;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

export function normalizeInjectedModelResponse(response: InjectedModelResponse) {
  if (response.ok && !response.body && typeof response.json !== 'function') {
    throw new Error('model endpoint 响应没有可读取的流或 JSON 正文');
  }
  const json = typeof response.json === 'function' ? () => response.json?.() as Promise<unknown> : async () => ({});
  const text = typeof response.text === 'function'
    ? () => response.text?.() || Promise.resolve('')
    : async () => JSON.stringify(await json());
  return { ok: response.ok, status: response.status, body: response.body || null, json, text };
}
