// PushManager.subscribe() wants the VAPID public key as a Uint8Array, but the
// server hands it over as a base64url string. This decodes one to the other:
// restore base64url to standard base64 (with padding) and unpack the bytes.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Back the view with a concrete ArrayBuffer so it satisfies the BufferSource
  // that PushManager.subscribe()'s applicationServerKey expects.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}
