import { describe, expect, it } from 'vitest';

import { urlBase64ToUint8Array } from './webPush';

describe('urlBase64ToUint8Array', () => {
  it('decodes a padded, standard base64 chunk to its bytes', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
  });

  it('restores missing base64 padding before decoding', () => {
    // "AQ" is unpadded base64 for a single byte; the helper must re-add "==".
    expect(Array.from(urlBase64ToUint8Array('AQ'))).toEqual([1]);
  });

  it('translates the base64url alphabet (- and _) back to + and /', () => {
    // base64url "a-_b" == base64 "a+/b" == bytes [107, 239, 219].
    expect(Array.from(urlBase64ToUint8Array('a-_b'))).toEqual([107, 239, 219]);
  });
});
