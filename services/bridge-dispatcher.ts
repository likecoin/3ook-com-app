export type SendToWebView = (data: object) => void;
export type BridgeHandler = (
  msg: Record<string, unknown>
) => void | Promise<void>;
export type BridgeHandlerMap = Record<string, BridgeHandler>;

const handlers = new Map<string, BridgeHandler>();

export function registerHandlers(
  map: BridgeHandlerMap
): void {
  for (const [type, handler] of Object.entries(map)) {
    handlers.set(type, handler);
  }
}

export async function dispatch(
  raw: string
): Promise<void> {
  let msg: { type: string; [key: string]: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn('[bridge] invalid JSON:', raw);
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    console.warn('[bridge] malformed message:', msg);
    return;
  }
  const handler = handlers.get(msg.type);
  if (!handler) {
    console.warn(`[bridge] unknown message type: ${msg.type}`);
    return;
  }
  await handler(msg);
}
