import type PostHog from 'posthog-react-native';
import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getIdentityHandlers(posthog: PostHog): BridgeHandlerMap;
