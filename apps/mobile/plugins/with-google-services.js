/**
 * Firebase for the relay's pushes (FCM), only when its config is there: the
 * file EAS provides through the GOOGLE_SERVICES_JSON file variable, or
 * apps/mobile/google-services.json kept out of git. Without either the app
 * builds as before and shows notifications only while it runs.
 * Setup: plans/notifications-setup.md in the ue-mcp repo.
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = function withGoogleServices(config) {
  const file = process.env.GOOGLE_SERVICES_JSON || path.join(__dirname, "..", "google-services.json");
  if (!fs.existsSync(file)) return config;
  return { ...config, android: { ...config.android, googleServicesFile: file } };
};
