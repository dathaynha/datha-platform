// Dynamic import required for Module Federation — defers Angular bootstrap so
// the MF runtime can negotiate shared singletons before the app initializes.
import("./bootstrap").catch((err) => console.error("Bootstrap failed", err));
