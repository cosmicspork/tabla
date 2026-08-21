/**
 * Reading a code with the camera.
 *
 * Two decoders, chosen per engine. Chrome and Android have `BarcodeDetector`
 * and decode in native code for nothing; Safari and Firefox do not, and get
 * jsQR — vendored at `/qr/jsqr.mjs`, fetched on the first tap of Scan and never
 * on a device that has the native one.
 *
 * That split is what makes scanning a real route on iOS rather than a button
 * that is never shown. It used to be neither: `scanningAvailable` asked for
 * `BarcodeDetector`, so on the one platform where a link cannot reach the
 * installed app — where scanning is worth the most, because it is the only way
 * a code gets in without going through Safari and the clipboard — the offer was
 * withheld entirely.
 *
 * The argument this file used to make against shipping a decoder was that it
 * would be "a few hundred kilobytes that most people would download to never
 * use". The second half was the real point and it is answered by fetching it
 * only where it is needed; the first half was wrong anyway, at ~57 kB over the
 * wire, against the half a megabyte of word list a Letras game already pulls.
 *
 * What is deliberately *not* here is any knowledge of what a code means. This
 * decodes; callers say whether the text is anything to them. A scan and a paste
 * then agree by construction, because they end in the same parser.
 */

/** A decoder, ready to be pointed at the picture the camera is showing. */
export type Reader = (source: HTMLVideoElement) => Promise<string | null>;

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

function nativeDetector(): BarcodeDetectorConstructor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

/**
 * Whether the camera can be offered at all.
 *
 * Only about the camera now, because the decoder is no longer in doubt: an
 * engine without a native one is handed jsQR. `getUserMedia` is absent outside
 * a secure context and on a device with no camera, and both mean the same thing
 * to the person — there is nothing to point at a code, so type it instead.
 */
export function scanningAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * The reader this engine should use, resolved once and used every frame.
 *
 * The two paths differ in more than the decoder. A native detector reads the
 * video element as it stands; jsQR wants pixels, which means a canvas and a
 * copy per frame. Keeping that difference in here is what lets the scanner
 * itself hold no opinion about which engine it is running on.
 */
export async function reader(): Promise<Reader> {
  const Native = nativeDetector();

  if (Native) {
    try {
      const detector = new Native({ formats: ['qr_code'] });
      return async (source) => (await detector.detect(source))[0]?.rawValue ?? null;
    } catch {
      // A constructor that exists but refuses `qr_code` is a decoder we do not
      // have. Fall through rather than fail: jsQR reads the same codes.
    }
  }

  // One canvas for the life of the scan, resized to whatever the camera gives.
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  return async (source) => {
    if (!context) return null;
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    context.drawImage(source, 0, 0);

    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return decodePixels(frame.data, frame.width, frame.height);
  };
}

/**
 * jsQR over one frame's pixels, with the module imported on demand.
 *
 * Separate from `reader` and free of the DOM so it can be tested against a
 * rendered code in Node, which is the half of scanning worth testing: a camera
 * cannot be asserted on, but "these pixels are that string" can.
 *
 * The path is held in a variable so Vite leaves it alone. This is a static file
 * kept out of the bundle and out of the install-time precache on purpose, and
 * resolving it at build time would pull it into both.
 */
export async function decodePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string | null> {
  const path = '/qr/jsqr.mjs';
  const loaded = (await import(/* @vite-ignore */ path)) as {
    default: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
  };

  return loaded.default(data, width, height)?.data ?? null;
}
