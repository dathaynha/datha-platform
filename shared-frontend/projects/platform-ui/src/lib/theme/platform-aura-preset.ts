import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

/**
 * Shared platform preset. Applications remain responsible for passing this
 * preset to providePrimeNG and selecting the `.dark` dark-mode selector.
 */
export const platformAuraPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: "#fdf2f8",
      100: "#fce7f3",
      200: "#fbcfe8",
      300: "#f9a8d4",
      400: "#f637e3",
      500: "#e879f9",
      600: "#8514f5",
      700: "#8001c6",
      800: "#5c44e4",
      900: "#0546ff",
      950: "#1e1b4b",
    },
  },
});
