declare global {
  namespace App {}

  interface Navigator {
    /** Safari-only signal that the PWA was launched from the home screen. */
    standalone?: boolean;
  }
}

export {};
