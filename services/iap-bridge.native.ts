import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Purchases, {
  INTRO_ELIGIBILITY_STATUS,
  PACKAGE_TYPE,
  PURCHASES_ERROR_CODE,
} from 'react-native-purchases';
import type {
  CustomerInfo,
  PurchasesError,
  PurchasesOffering,
  PurchasesOfferings,
  PurchasesPackage,
  PurchasesStoreProduct,
} from 'react-native-purchases';

import type { AnalyticsProperties } from './analytics';
import { getFirebaseAppInstanceId, trackEvent } from './analytics';
import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';
import { addDeviceTokenListener, getCurrentDeviceToken } from './push-bridge';
import { openExternalURL } from './url-bridge';

// Entitlement identifier configured in the RevenueCat dashboard. A web (Stripe)
// or mobile (StoreKit / Play Billing) subscriber both resolve to this single
// entitlement, so feature gating is identical across platforms. Must match the
// identifier set up in the dashboard.
const PLUS_ENTITLEMENT_ID = 'plus';

// Civic — the tier above Plus. It ships as a dedicated RevenueCat offering
// (never the dashboard's "current" one, which stays Plus for older web builds)
// and its own entitlement. Both must match the RevenueCat dashboard.
const CIVIC_ENTITLEMENT_ID = 'civic';
const CIVIC_OFFERING_ID = 'civic';

// Generic store subscription-management pages. Used as a fallback when
// RevenueCat's showManageSubscriptions() throws because it can't resolve a
// product-specific management URL — notably sandbox/test subscriptions (where
// managementURL is null), so an active subscriber can still reach the store UI.
const MANAGE_SUBSCRIPTION_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/account/subscriptions'
    : 'https://play.google.com/store/account/subscriptions';

type RevenueCatConfig = { iosApiKey?: string; androidApiKey?: string };

function getApiKey(): string | undefined {
  const cfg = (Constants.expoConfig?.extra?.revenueCat ?? {}) as RevenueCatConfig;
  return Platform.OS === 'ios' ? cfg.iosApiKey : cfg.androidApiKey;
}

// Drives the `iap` capability string in app/index.tsx — only advertised when a
// platform key exists, so a misconfigured build doesn't surface a dead
// purchase button on the web side.
export function isIAPAvailable(): boolean {
  return !!getApiKey();
}

let configured = false;

// Latest device push token (APNs/FCM), kept current by the listener set up in
// configureIAP. Setting it on each delivery attaches it to the current RC user;
// applyDeviceAttributes re-asserts it per login (RC scopes attributes to the
// current appUserID). Null until the first token is delivered.
let knownPushToken: string | null = null;
function rememberPushToken(token: string): void {
  if (!token) return;
  knownPushToken = token;
  Purchases.setPushToken(token).catch((e) => console.warn('[iap] setPushToken failed', e));
}

// Configure once on app start (singleton). Anonymous until the identity bridge
// logs the user in via wrapIdentityForIAP; pairing logIn with `identifyUser`
// keeps the RevenueCat appUserID equal to the backend internal user id (likerId).
export function configureIAP(): void {
  if (configured) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[iap] RevenueCat API key missing for this platform — IAP disabled.');
    return;
  }
  Purchases.configure({ apiKey, appUserID: null });
  configured = true;
  // Apple Ads attribution. RevenueCat exchanges the AAAttribution token
  // server-side (iOS 14.3+, standard payload, no ATT consent). Simulator has no
  // AdServices and the native call hangs there, so device-only and never awaited.
  if (Platform.OS === 'ios' && Device.isDevice) {
    Purchases.enableAdServicesAttributionTokenCollection()
      .catch((e) => console.warn('[iap] AdServices token collection failed', e));
  }
  // Source the push token from the listener, never the identify path:
  // getDevicePushTokenAsync re-triggers remote-registration, so fetching it on
  // every identify would churn APNs/FCM registration (see intercom-bridge). One
  // bootstrap fetch to register, then the listener delivers refreshes.
  addDeviceTokenListener(rememberPushToken);
  getCurrentDeviceToken().then((token) => {
    if (token) rememberPushToken(token);
  });
}

function hasPlus(customerInfo: CustomerInfo): boolean {
  return customerInfo.entitlements.active[PLUS_ENTITLEMENT_ID] !== undefined;
}

function hasCivic(customerInfo: CustomerInfo): boolean {
  return customerInfo.entitlements.active[CIVIC_ENTITLEMENT_ID] !== undefined;
}

// Normalizes the web's optional `tier` field. Anything but 'civic' (missing,
// unknown, or 'plus') resolves to 'plus' so older web builds that never send
// a tier keep the pre-Civic purchase behavior unchanged.
function normalizeTier(tier: unknown): 'plus' | 'civic' {
  return tier === 'civic' ? 'civic' : 'plus';
}

// Resolves the offering a tier buys from: Civic reads its dedicated offering
// by id; Plus keeps using the dashboard's current offering. Null when the
// Civic offering isn't configured, so callers surface an error rather than
// silently falling back to (and charging) the Plus offering.
function offeringForTier(
  offerings: PurchasesOfferings,
  tier: 'plus' | 'civic',
): PurchasesOffering | null {
  return tier === 'civic' ? (offerings.all[CIVIC_OFFERING_ID] ?? null) : offerings.current;
}

// Maps the web's SubscriptionPlan period onto RevenueCat's predefined package
// types. Partial so an unknown period yields `undefined` (not a fake hit),
// letting the caller surface an error rather than silently charging a default.
const PERIOD_TO_PACKAGE_TYPE: Partial<Record<string, PACKAGE_TYPE>> = {
  monthly: PACKAGE_TYPE.MONTHLY,
  yearly: PACKAGE_TYPE.ANNUAL,
};

function packageForPeriod(
  packages: PurchasesPackage[],
  period: string,
): PurchasesPackage | undefined {
  const wanted = PERIOD_TO_PACKAGE_TYPE[period];
  if (!wanted) return undefined;
  // Only the exact package type for the requested period — never a fallback,
  // so we never charge a plan the user didn't pick (e.g. annual for monthly).
  return packages.find((p) => p.packageType === wanted);
}

// Custom subscriber attributes the web forwards to RevenueCat (gift book class id,
// affiliate channel, ad-attribution ids) so they reach the backend grant webhook
// in the event's subscriber_attributes — the IAP analogue of Stripe checkout
// metadata. Plain string values are kept, and reserved ($-prefixed) keys are
// dropped so the web can never clobber RevenueCat's own attributes (e.g. $email,
// $idfa). Empty strings are kept on purpose: the web sends '' to clear a sticky
// attribute (e.g. a prior gift's plusGiftClassId), which RevenueCat treats as a
// tombstone — filtering them out would leave the stale value and re-grant the gift.
function extractSubscriberAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || key.startsWith('$')) continue;
    if (typeof raw !== 'string') continue;
    result[key] = raw.trim();
  }
  return result;
}

// Mirror the web's resolved campaign / mediaSource onto RevenueCat's reserved
// $campaign / $mediaSource — not last-touch utmSource, usually an internal
// surface name here, which RC keeps forever. '' is a no-op, never a clear.
async function applyAttributionAttributes(attributes: Record<string, string>): Promise<void> {
  const ops: Promise<void>[] = [];
  if (attributes.campaign) ops.push(Purchases.setCampaign(attributes.campaign));
  if (attributes.mediaSource) ops.push(Purchases.setMediaSource(attributes.mediaSource));
  if (!ops.length) return;
  try {
    await Promise.all(ops);
  } catch (e) {
    console.warn('[iap] failed to set attribution attributes', e);
  }
}

// Populate RevenueCat's reserved identity/integration attributes from the
// identity payload so the dashboard resolves a real person and RC's PostHog
// integration stitches to the same person. $posthogUserId is the evmWallet
// (`userId`) both web and native identify PostHog under — so RC's events attach
// to that unified person; PostHog has no dedicated setter so it goes through
// setAttributes. Set only when present (RC treats '' as a delete). Best-effort.
async function applyIdentityAttributes(msg: Record<string, unknown>): Promise<void> {
  const ops: Promise<void>[] = [];
  const email = typeof msg.email === 'string' ? msg.email.trim() : '';
  const displayName = typeof msg.displayName === 'string' ? msg.displayName.trim() : '';
  const posthogUserId = typeof msg.userId === 'string' ? msg.userId.trim() : '';
  if (email) ops.push(Purchases.setEmail(email));
  if (displayName) ops.push(Purchases.setDisplayName(displayName));
  if (posthogUserId) ops.push(Purchases.setAttributes({ $posthogUserId: posthogUserId }));
  if (!ops.length) return;
  try {
    await Promise.all(ops);
  } catch (e) {
    console.warn('[iap] failed to set identity attributes', e);
  }
}

// Populate RevenueCat's reserved device attributes (push token, Firebase app
// instance id) so RC's push re-engagement and Firebase integrations resolve the
// same device. Re-asserts the cached push token (never re-fetches — see
// configureIAP) so it attaches to the logged-in user. Set only when present (RC
// treats '' as a delete). Best-effort and additive.
async function applyDeviceAttributes(): Promise<void> {
  const firebaseAppInstanceId = await getFirebaseAppInstanceId();
  const ops: Promise<void>[] = [];
  if (knownPushToken) ops.push(Purchases.setPushToken(knownPushToken));
  if (firebaseAppInstanceId) ops.push(Purchases.setFirebaseAppInstanceID(firebaseAppInstanceId));
  if (!ops.length) return;
  try {
    await Promise.all(ops);
  } catch (e) {
    console.warn('[iap] failed to set device attributes', e);
  }
}

// The web's trial model is expressed in days; store intro durations are
// period+unit (iOS `periodUnit`, Android `Period.unit`, both DAY/WEEK/MONTH/YEAR).
// Month/year are approximated so "2 weeks" → 14, "1 month" → 30 for display copy.
const DAYS_PER_UNIT: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

function periodToDays(unit: string | undefined, count: number): number {
  const per = unit ? DAYS_PER_UNIT[unit] : undefined;
  return per ? per * count : 0;
}

// Intro offer normalized for the web: the displayed trial must match what the
// store will actually grant (and the charged price the user will see), so the
// web reads these instead of hardcoding a trial it can't guarantee.
type IntroOffer = {
  trialPeriodDays: number;
  isFreeTrial: boolean;
  introPrice: number;
  introPriceString: string;
};

// Pulls the single intro offer the store attaches to the product. iOS exposes it
// as `introPrice`; Android (Play) exposes it as the default option's free / intro
// pricing phase. Returns undefined when there's no intro offer (user pays full
// price immediately) so the web shows no trial rather than a fictitious one.
function extractIntroOffer(product: PurchasesStoreProduct): IntroOffer | undefined {
  // iOS — one introductory offer per product (free trial, pay-as-you-go, or
  // pay-up-front). `cycles` is the number of intro billing periods (1 for a
  // free trial / pay-up-front), so total duration = period × cycles.
  const ios = product.introPrice;
  if (ios) {
    const cycles = ios.cycles > 0 ? ios.cycles : 1;
    return {
      trialPeriodDays: periodToDays(ios.periodUnit, ios.periodNumberOfUnits) * cycles,
      isFreeTrial: ios.price === 0,
      introPrice: ios.price,
      introPriceString: ios.priceString,
    };
  }

  // Android — the free-trial phase takes precedence over a paid intro phase
  // (a product can carry both). Price comes in micro-units.
  const phase = product.defaultOption?.freePhase ?? product.defaultOption?.introPhase;
  if (phase) {
    const cycles = phase.billingCycleCount && phase.billingCycleCount > 0 ? phase.billingCycleCount : 1;
    const price = phase.price.amountMicros / 1_000_000;
    return {
      trialPeriodDays: periodToDays(phase.billingPeriod.unit, phase.billingPeriod.value) * cycles,
      isFreeTrial: price === 0,
      introPrice: price,
      introPriceString: phase.price.formatted,
    };
  }

  return undefined;
}

// Returns intro-offer product ids eligible for the current store account.
// StoreKit advertises offers regardless of per-subscription-group eligibility.
// Returning subscribers otherwise see the full price at the payment sheet.
async function getIntroEligibleProductIds(productIds: string[]): Promise<Set<string>> {
  // Android always answers UNKNOWN, and Play already omits offers the account can't use
  // from the product's options, so gating there would hide every Android intro offer.
  if (Platform.OS !== 'ios') return new Set(productIds);
  if (!productIds.length) return new Set();
  try {
    const eligibility = await Purchases.checkTrialOrIntroductoryPriceEligibility(productIds);
    // Only a definite ELIGIBLE shows the offer. UNKNOWN (RevenueCat couldn't resolve the
    // subscription group) falls back to the non-intro price, per RevenueCat's guidance:
    // under-promising costs an upsell, over-promising is a bait-and-switch.
    return new Set(
      productIds.filter(
        (id) => eligibility[id]?.status
          === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE,
      ),
    );
  } catch (e) {
    // Fail closed for the same reason — no trial shown is the safe outcome.
    console.warn('[iap] intro eligibility check failed', e);
    return new Set();
  }
}

// The web sends the backend internal user id as `likerId`. Normalize it
// identically everywhere (trim; empty → undefined) so identifyUser logs in under
// exactly the id purchase/restore expect — a stray space would mint a distinct
// RevenueCat appUserID the webhook can't resolve. `userId` is the evmWallet
// (analytics only) and must never be used here.
function normalizeLikerId(likerId: unknown): string | undefined {
  return typeof likerId === 'string' && likerId.trim() ? likerId.trim() : undefined;
}

// Firebase Analytics truncates parameter values past 100 characters.
const MAX_ERROR_MESSAGE_LENGTH = 100;

// Splits the single `exception` bucket by store-side cause — a store outage, a
// dropped network and a pending payment otherwise look identical. Keys are omitted
// rather than set to undefined so a non-RevenueCat throw records no empty properties.
function errorProperties(e: unknown): AnalyticsProperties {
  const err = (e ?? {}) as Partial<PurchasesError>;
  // Names the PURCHASES_ERROR_CODE (STORE_PROBLEM_ERROR, NETWORK_ERROR…), which is
  // the dimension worth breaking down on. Deprecated at the top level, so via userInfo.
  const readableCode = err.userInfo?.readableErrorCode;
  // The cast is an assertion, not a guarantee — a non-RevenueCat throw can carry a
  // non-string message, and slicing that would throw from inside a catch block.
  const raw = err.underlyingErrorMessage || err.message;
  const message = typeof raw === 'string' ? raw.slice(0, MAX_ERROR_MESSAGE_LENGTH) : '';
  return {
    ...(readableCode && { readable_code: readableCode }),
    ...(message && { error_message: message }),
  };
}

// Logs the user into RevenueCat under `appUserId` (the backend internal user id
// / likerId) so purchases attribute to the right user for the webhook to match.
// Used by identifyUser (best-effort), and re-checked before purchase/restore as a
// cold-start fallback. logIn is idempotent when appUserId is unchanged. Returns
// false on failure so purchase/restore can fail closed rather than act under an
// id the backend webhook can't resolve.
async function ensureLoggedIn(appUserId?: string): Promise<boolean> {
  if (!appUserId) return false;
  try {
    await Purchases.logIn(appUserId);
    return true;
  } catch (e) {
    console.warn('[iap] ensureLoggedIn failed', e);
    return false;
  }
}

export function wrapIdentityForIAP(base: BridgeHandlerMap): BridgeHandlerMap {
  if (!isIAPAvailable()) return base;
  return {
    ...base,
    identifyUser: async (msg) => {
      // RevenueCat's appUserID must equal our backend's internal user id
      // (`likerId` = Firestore doc id), since that is what the RevenueCat→backend
      // webhook resolves against and what the Stripe path attributes purchases to.
      // The web sends it as `likerId`; `userId` is the evmWallet (analytics only)
      // and must NOT be used here.
      const appUserId = normalizeLikerId(msg.likerId);
      await Promise.all([
        base.identifyUser?.(msg),
        // Set attributes only after login succeeds, so they attach to the
        // resolved appUserID rather than a soon-to-be-merged anonymous one.
        (async () => {
          if (await ensureLoggedIn(appUserId)) {
            await Promise.all([applyIdentityAttributes(msg), applyDeviceAttributes()]);
          }
        })(),
      ]);
    },
    resetUser: async (msg) => {
      await Promise.all([
        base.resetUser?.(msg),
        (async () => {
          try {
            await Purchases.logOut();
          } catch (e) {
            // logOut throws if the SDK is already anonymous — benign.
            console.warn('[iap] logOut failed', e);
          }
        })(),
      ]);
    },
  };
}

export function getIAPHandlers(send: SendToWebView): BridgeHandlerMap {
  if (!isIAPAvailable()) return {};

  return {
    iapPurchase: async (msg) => {
      // No default period: a malformed payload must error, not silently charge
      // the most expensive plan.
      const period = typeof msg.period === 'string' ? msg.period : '';
      const tier = normalizeTier(msg.tier);
      // A period the store doesn't define would otherwise fall through to the
      // generic "no package" path; surface it distinctly so the web can tell a
      // malformed request apart from an offering that's genuinely missing.
      if (!(period in PERIOD_TO_PACKAGE_TYPE)) {
        send({ type: 'iapPurchaseResult', status: 'error', period, tier, message: 'Invalid period' });
        trackEvent('iap_purchase_error', { period, tier, reason: 'invalid_period' });
        return;
      }
      // Required: a purchase under an anonymous id can never be credited by the
      // backend webhook (which resolves entitlement by likerId), so the user
      // would pay and get nothing. Refuse instead.
      const appUserId = normalizeLikerId(msg.likerId);
      if (!appUserId) {
        send({ type: 'iapPurchaseResult', status: 'error', period, tier, message: 'Missing user id' });
        trackEvent('iap_purchase_error', { period, tier, reason: 'missing_liker_id' });
        return;
      }
      try {
        if (!(await ensureLoggedIn(appUserId))) {
          send({ type: 'iapPurchaseResult', status: 'error', period, tier, message: 'Sign-in failed' });
          trackEvent('iap_purchase_error', { period, tier, reason: 'login_failed' });
          return;
        }
        const offerings = await Purchases.getOfferings();
        const offering = offeringForTier(offerings, tier);
        const pkg = packageForPeriod(offering?.availablePackages ?? [], period);
        if (!pkg) {
          // Distinguish a missing/empty Civic offering so a misconfigured
          // dashboard doesn't look like the generic Plus no-package case.
          const message =
            tier === 'civic'
              ? 'No Civic package available'
              : 'No package available';
          send({ type: 'iapPurchaseResult', status: 'error', period, tier, message });
          trackEvent('iap_purchase_error', {
            period,
            tier,
            reason: tier === 'civic' ? 'no_civic_package' : 'no_package',
          });
          return;
        }
        // Set the web's gift/affiliate/attribution as subscriber attributes right
        // before the purchase so they sync with the receipt and land on the backend
        // grant webhook. Best-effort — a failed sync is logged, never fails the purchase.
        const attributes = extractSubscriberAttributes(msg.attributes);
        if (Object.keys(attributes).length) {
          try {
            // Await so the attributes are flushed to RevenueCat before the purchase
            // sync, and so a failure is caught here rather than surfacing as an
            // unhandled rejection. Best-effort — never block the purchase on it.
            await Purchases.setAttributes(attributes);
          } catch (attrErr) {
            console.warn('[iap] failed to set subscriber attributes', attrErr);
          }
          // Also mirror the resolved channel onto RC's reserved attribution keys.
          await applyAttributionAttributes(attributes);
        }
        const { customerInfo } = await Purchases.purchasePackage(pkg);
        const isPlus = hasPlus(customerInfo);
        const isCivic = hasCivic(customerInfo);
        send({
          type: 'iapPurchaseResult',
          status: 'success',
          period,
          tier,
          isPlus,
          isCivic,
          productId: pkg.product.identifier,
        });
        trackEvent('iap_purchase_success', {
          period,
          tier,
          product_id: pkg.product.identifier,
          is_plus: isPlus,
          is_civic: isCivic,
        });
      } catch (e) {
        const err = e as Partial<PurchasesError>;
        // Not err.userCancelled — it is deprecated, and the SDK derives it from this code.
        if (err.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
          send({ type: 'iapPurchaseResult', status: 'cancelled', period, tier });
          trackEvent('iap_purchase_cancelled', { period, tier });
          return;
        }
        // Names the PURCHASES_ERROR_CODE so the web can tell a user-side store
        // condition from a real failure; err.code is the bare ordinal ("3"). Both
        // are asserted, not guaranteed — a non-RevenueCat throw can be non-string.
        const readableCode = err.userInfo?.readableErrorCode;
        send({
          type: 'iapPurchaseResult',
          status: 'error',
          period,
          tier,
          message: (typeof err.message === 'string' && err.message) || 'Purchase failed',
          code: typeof readableCode === 'string' ? readableCode : undefined,
        });
        trackEvent('iap_purchase_error', { period, tier, reason: 'exception', ...errorProperties(e) });
        console.warn('[iap] purchase failed', e);
      }
    },

    // App Store guideline 3.1.1 requires an account-based restore path.
    iapRestore: async (msg) => {
      // Like iapPurchase: an entitlement restored under an anonymous id can't be
      // resolved by the backend webhook (which keys on likerId), so require it and
      // log in first. The web only exposes restore to logged-in users.
      const appUserId = normalizeLikerId(msg.likerId);
      if (!appUserId) {
        send({ type: 'iapRestoreResult', status: 'error', message: 'Missing user id' });
        trackEvent('iap_restore_error', { reason: 'missing_liker_id' });
        return;
      }
      try {
        if (!(await ensureLoggedIn(appUserId))) {
          send({ type: 'iapRestoreResult', status: 'error', message: 'Sign-in failed' });
          trackEvent('iap_restore_error', { reason: 'login_failed' });
          return;
        }
        const customerInfo = await Purchases.restorePurchases();
        const isPlus = hasPlus(customerInfo);
        const isCivic = hasCivic(customerInfo);
        send({ type: 'iapRestoreResult', status: 'success', isPlus, isCivic });
        trackEvent('iap_restore_success', { is_plus: isPlus, is_civic: isCivic });
      } catch (e) {
        const err = e as Partial<PurchasesError>;
        send({ type: 'iapRestoreResult', status: 'error', message: err.message || 'Restore failed' });
        trackEvent('iap_restore_error', { reason: 'exception', ...errorProperties(e) });
        console.warn('[iap] restore failed', e);
      }
    },

    // Opens the native store subscription-management UI (iOS App Store sheet /
    // Play subscriptions). The web routes only store-owned subscribers here;
    // Stripe subscribers go to the Stripe portal instead. Resolves once the UI
    // is presented — the SDK can't report what the user changed, so the web
    // just refreshes the session afterward.
    iapManageSubscription: async () => {
      let isFallback = false;
      try {
        await Purchases.showManageSubscriptions();
      } catch (e) {
        // RevenueCat can't always resolve a product-specific management URL
        // (sandbox subscriptions have a null managementURL, and some devices
        // can't open the store intent). Fall back to the store's generic
        // subscriptions page so an active subscriber isn't left stranded.
        try {
          await openExternalURL(MANAGE_SUBSCRIPTION_URL);
          isFallback = true;
        } catch (fallbackError) {
          const err = e as Partial<PurchasesError>;
          send({ type: 'iapManageResult', status: 'error', message: err.message || 'Manage failed' });
          // The showManageSubscriptions failure, not the fallback's — it says why the
          // native sheet couldn't be resolved.
          trackEvent('iap_manage_error', errorProperties(e));
          console.warn('[iap] manage subscription failed', e, fallbackError);
          return;
        }
      }
      send({ type: 'iapManageResult', status: 'success' });
      trackEvent('iap_manage_opened', isFallback ? { is_fallback: true } : undefined);
    },

    // Lets the web display App Store / Play-accurate prices instead of the
    // Stripe-configured ones (displayed price must equal the charged price).
    // Also carries the store's intro offer (`trialPeriodDays` / `isFreeTrial` /
    // `introPrice…`) so the web shows the trial the store will actually grant
    // rather than a hardcoded one — omitted when the product has no intro offer,
    // or when this store account is no longer eligible for it.
    iapGetOfferings: async (msg) => {
      // Same optional `tier` field as iapPurchase; the tier is echoed back so
      // the web can match a response to the offering it asked for. A missing
      // or empty Civic offering just yields an empty `packages` array.
      const tier = normalizeTier(msg.tier);
      try {
        const offerings = await Purchases.getOfferings();
        const offering = offeringForTier(offerings, tier);
        const availablePackages = offering?.availablePackages ?? [];
        // Resolve the offers first so eligibility is only asked about products that
        // actually carry one — the iOS check fetches and inspects each id serially.
        const introByProductId = new Map<string, IntroOffer>();
        availablePackages.forEach((p) => {
          const intro = extractIntroOffer(p.product);
          if (intro) introByProductId.set(p.product.identifier, intro);
        });
        const introEligible = await getIntroEligibleProductIds([...introByProductId.keys()]);
        const packages = availablePackages.map((p) => {
          // Drop the offer entirely rather than reporting it with a flag: the web reads
          // a missing intro as "no trial", which is exactly what this user gets.
          const intro = introEligible.has(p.product.identifier)
            ? introByProductId.get(p.product.identifier)
            : undefined;
          return {
            period:
              p.packageType === PACKAGE_TYPE.MONTHLY
                ? 'monthly'
                : p.packageType === PACKAGE_TYPE.ANNUAL
                  ? 'yearly'
                  : p.identifier,
            productId: p.product.identifier,
            priceString: p.product.priceString,
            price: p.product.price,
            currency: p.product.currencyCode,
            ...(intro && {
              trialPeriodDays: intro.trialPeriodDays,
              isFreeTrial: intro.isFreeTrial,
              introPrice: intro.introPrice,
              introPriceString: intro.introPriceString,
            }),
          };
        });
        send({ type: 'iapOfferings', tier, packages });
      } catch (e) {
        // The web reads an empty `packages` as "no plans available" and renders a
        // priceless paywall, so without this a failed catalog fetch leaves no trace.
        send({ type: 'iapOfferings', tier, packages: [] });
        trackEvent('iap_offerings_error', { tier, ...errorProperties(e) });
        console.warn('[iap] getOfferings failed', e);
      }
    },
  };
}
