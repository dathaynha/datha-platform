/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    // Shell's own sources
    "./src/**/*.{html,ts}",
    // Remote apps: the shell ships the shared Tailwind CSS bundle, so it must
    // scan every remote's templates/components to generate all utility classes
    // they rely on. Add a new line here for each remote that gets onboarded.
    "../chatbot-frontend/src/**/*.{html,ts}",
    "../event-store-frontend/src/**/*.{html,ts}",
    "../messenger-frontend/src/**/*.{html,ts}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
