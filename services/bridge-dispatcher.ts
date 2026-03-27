export type SendToWebView = (data: object) => void;
export type BridgeHandler = (
  msg: Record<string, unknown>
) => void | Promise<void>;
export type BridgeHandlerMap = Record<string, BridgeHandler>;

type MessageHandler = (
  msg: Record<string, unknown>,
  sendToWebView: SendToWebView
) => void | Promise<void>;

const handlers = new Map<string, MessageHandler>();

export function registerHandlers(
  map: Record<string, MessageHandler>
): void {
  for (const [type, handler] of Object.entries(map)) {
    handlers.set(type, handler);
  }
}

export async function dispatch(
  raw: string,
  sendToWebView: SendToWebView
): Promise<void> {
  const msg: { type: string; [key: string]: unknown } = JSON.parse(raw);
  const handler = handlers.get(msg.type);
  if (!handler) {
    console.warn(`[bridge] unknown message type: ${msg.type}`);
    return;
  }
  await handler(msg, sendToWebView);
}
