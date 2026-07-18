import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../api/client';
import { urlBase64ToUint8Array } from '../lib/webPush';

export type WebPushState =
  | 'loading' // still determining support / server config / current subscription
  | 'unsupported' // this browser has no Web Push at all
  | 'unconfigured' // the server has no VAPID keys, so push is off everywhere
  | 'ios-needs-install' // iOS only delivers push to a Home-Screen-installed PWA
  | 'denied' // the user blocked notifications in the browser
  | 'off' // supported and permitted, but not currently subscribed
  | 'on'; // subscribed and registered with the server for the current user

export interface UseWebPushResult {
  state: WebPushState;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPhone/iPod always identify as iOS; iPadOS 13+ masquerades as a Mac, so a
  // touch-capable "Macintosh" is treated as iOS too.
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return window.matchMedia?.('(display-mode: standalone)').matches === true || iosStandalone;
}

// Registers a browser subscription with the server for the CURRENT user.
// 'conflict' means the endpoint is bound to another account (e.g. a shared
// browser after a failed logout teardown) — the caller must re-subscribe fresh.
async function postSubscription(
  subscription: PushSubscription,
): Promise<'ok' | 'conflict' | 'error'> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return 'error';
  try {
    await api.subscribePush({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return 'conflict';
    return 'error';
  }
}

// Best-effort local unsubscribe, used on session expiry: the server DELETE would
// 401 without a session, but deactivating the endpoint in the browser makes the
// next server send 404/410 and the row is pruned then. This stops a shared
// device from receiving the previous user's notifications after their session
// ends without an explicit sign-out.
async function unsubscribeLocal(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    await subscription?.unsubscribe();
  } catch {
    // Nothing actionable — teardown is best-effort.
  }
}

async function subscribeAndRegister(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<boolean> {
  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  let createdHere = false;
  if (subscription === null) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    createdHere = true;
  }
  const posted = await postSubscription(subscription);
  if (posted === 'ok') return true;
  if (posted === 'conflict') {
    // The reused endpoint belongs to another account — replace it with a fresh one.
    await subscription.unsubscribe().catch(() => undefined);
    const fresh = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    if ((await postSubscription(fresh)) === 'ok') return true;
    await fresh.unsubscribe().catch(() => undefined);
    return false;
  }
  // Server rejected it: undo the browser subscription only if we created it here,
  // so we never leave a live subscription with no matching server row.
  if (createdHere) await subscription.unsubscribe().catch(() => undefined);
  return false;
}

// Manages the browser's push permission + subscription and keeps the server's
// stored subscription in sync. Safe to call in dev (registers the service
// worker on demand rather than assuming main.tsx already did).
export function useWebPush(): UseWebPushResult {
  const [state, setState] = useState<WebPushState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicKeyRef = useRef<string | null>(null);
  // False while we could not reach the config endpoint, so transient failures
  // keep retrying instead of permanently hiding the toggle.
  const resolvedRef = useRef(false);

  const init = useCallback(async () => {
    if (!pushSupported()) {
      // On iOS the PushManager only exists inside an installed PWA, so an
      // unsupported result there means "install first", not "never".
      resolvedRef.current = true;
      setState(isIos() && !isStandalone() ? 'ios-needs-install' : 'unsupported');
      return;
    }
    let config;
    try {
      config = await api.pushConfig();
    } catch {
      // Transient (offline / cold-start 5xx): stay 'loading' and let the retry
      // listeners re-attempt rather than masquerading as 'unconfigured'.
      resolvedRef.current = false;
      setState('loading');
      return;
    }
    if (!config.enabled || !config.publicKey) {
      resolvedRef.current = true;
      setState('unconfigured');
      return;
    }
    publicKeyRef.current = config.publicKey;
    if (Notification.permission === 'denied') {
      resolvedRef.current = true;
      setState('denied');
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription === null) {
        resolvedRef.current = true;
        setState('off');
        return;
      }
      // Reconcile: the server is source of truth. Bind this endpoint to the
      // current user before showing 'on'.
      const result = await postSubscription(subscription);
      if (result === 'ok') {
        resolvedRef.current = true;
        setState('on');
      } else if (result === 'conflict') {
        // Bound to another account (shared browser): drop the stale subscription
        // so enable() can mint a fresh one under this user.
        await subscription.unsubscribe().catch(() => undefined);
        resolvedRef.current = true;
        setState('off');
      } else {
        // Transient failure reaching the server — stay unresolved so the retry
        // listeners re-attempt, rather than falsely reporting 'off' while a live
        // subscription still exists.
        resolvedRef.current = false;
        setState('loading');
      }
    } catch {
      resolvedRef.current = true;
      setState('off');
    }
  }, []);

  useEffect(() => {
    let active = true;
    const run = () => {
      if (active) void init();
    };
    run();
    // Only re-attempt while unresolved (a config fetch that failed), so we don't
    // re-POST the subscription on every tab focus once settled.
    const retry = () => {
      if (active && !resolvedRef.current) run();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry();
    };
    // A session that ends by expiry/401 (rather than an explicit sign-out) never
    // runs the logout teardown, so tear the local subscription down here too.
    const onUnauthorized = () => {
      void unsubscribeLocal();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('relaydock:unauthorized', onUnauthorized);
    return () => {
      active = false;
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('relaydock:unauthorized', onUnauthorized);
    };
  }, [init]);

  const enable = useCallback(async () => {
    const publicKey = publicKeyRef.current;
    if (publicKey === null) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const registration =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      const ok = await subscribeAndRegister(registration, publicKey);
      setState(ok ? 'on' : 'off');
      if (!ok) setError('Enable failed. Tap to retry.');
    } catch (caught) {
      // Keep the message short and fixed — a raw DOMException can be long enough
      // to overflow the mobile header; log the detail for debugging instead.
      console.warn('Enabling push notifications failed', caught);
      setState('off');
      setError('Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription !== null) {
        const { endpoint } = subscription;
        await subscription.unsubscribe();
        // Best-effort server cleanup; a stale row is pruned on the next failed send.
        await api.unsubscribePush(endpoint).catch(() => undefined);
      }
      setState('off');
    } catch (caught) {
      console.warn('Disabling push notifications failed', caught);
      setError('Could not turn off notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, error, enable, disable };
}
