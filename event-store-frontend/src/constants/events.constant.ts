/** Default page size for event list queries. */
export const EVENTS_PAGE_SIZE = 50;

/**
 * Offered page sizes. An ops list is scanned, so the useful question is "how
 * much of this do I want on screen", not "which page am I on" — 50 stays the
 * default because that is what these lists were built around.
 */
export const EVENTS_PAGE_SIZE_OPTIONS = [10, 30, 50];
