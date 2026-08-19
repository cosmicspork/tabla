// Pure SPA: no SSR, no prerendering. All state is local and encrypted, and the
// invite key in `location.hash` must never be sent to a server.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';
