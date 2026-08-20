/**
 * What the header calls the page you are on.
 *
 * Set by the page rather than mapped from the route, because a route is not
 * always enough to name a screen: `/g/[gameId]` is called Letras or Tic tac
 * toe depending on what is in the record, and the record is not read until the
 * page runs. Home leaves it empty and gets the wordmark instead.
 */
export const pageTitle = $state({ text: '' });
