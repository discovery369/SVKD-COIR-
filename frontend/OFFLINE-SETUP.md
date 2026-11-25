# SVKD COIR offline support

This project now includes a web app service worker and a web app manifest.

## What is covered

- The Expo web app shell is cached for offline startup after the first successful online load.
- Same-origin JavaScript, stylesheets, fonts, images, and other GET assets are cached as the app uses them.
- App navigation falls back to the cached single-page app when the network is unavailable.
- Existing income, expense, category, profile, and backup data continue to use the app's existing AsyncStorage persistence.
- The native Android/iOS app continues to use its native storage implementation; the web service worker is web-only.

## Build and deploy

From the `frontend` directory:

```bash
yarn install
npx expo export --platform web
```

Deploy the generated `dist` directory to an HTTPS static host. Ensure these files are present at the deployed site root:

- `sw.js`
- `manifest.webmanifest`
- `icons/app-icon.png`
- `index.html`

Expo copies files from `frontend/public` into the web export.

## First-time offline setup

1. Open the deployed app while connected to the internet.
2. Allow the first load to finish. The page may reload once when the service worker takes control.
3. Leave the app open briefly so all requested app assets can be cached.
4. Reload once, then test by enabling airplane mode and reopening the app.

Offline availability is limited to resources that were successfully loaded and cached before going offline. A first visit cannot work offline. External links such as WhatsApp, and any future server/API requests, still require connectivity.

## Updating the app

When deploying a release that changes cached files, increment `CACHE_VERSION` in `frontend/public/sw.js`. This causes old SVKD COIR caches to be cleaned up on activation.
