/**
 * Reading a link code with the camera.
 *
 * Uses the browser's own `BarcodeDetector` where there is one — Chrome and
 * Android have it, Safari and Firefox do not — rather than shipping a decoder.
 * A QR decoder is a few hundred kilobytes that most people would download to
 * never use, and typing six words takes under a minute, so scanning is the
 * shortcut and not the route.
 */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

function detector(): BarcodeDetectorConstructor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

export function scanningAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices) && Boolean(detector());
}

/** The words from a scanned code, or null if nothing was found in time. */
export async function scanForWords(timeoutMs = 20_000): Promise<string | null> {
  const Detector = detector();
  if (!Detector) return null;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
  });

  const video = document.createElement('video');
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  await video.play();

  const barcodes = new Detector({ formats: ['qr_code'] });
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const found = await barcodes.detect(video).catch(() => []);
      const words = found.map(wordsIn).find((value) => value !== null);
      if (words) return words;

      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** The fragment of a link URL, which is where the words live. */
function wordsIn(barcode: DetectedBarcode): string | null {
  try {
    const fragment = new URL(barcode.rawValue).hash.replace(/^#/, '');
    return fragment ? decodeURIComponent(fragment).replace(/-/g, ' ') : null;
  } catch {
    return null;
  }
}
