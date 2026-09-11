// @veorec/api — public surface (T-301).
//
// Application code mounts the router; it never reaches into the handlers.
// The router owns orchestration only: PostgreSQL goes through @veorec/db
// repositories and object storage through @veorec/storage, so this package
// contains no SQL and no storage SDK.
'use strict';

const { createUploadRouter, defaultEntitlements } = require('./uploads.router');
const { createRecordingsRouter, defaultEntitlements: defaultRecordingEntitlements } = require('./recordings.router');
const errors = require('./errors');

module.exports = {
  createUploadRouter, defaultEntitlements,
  createRecordingsRouter, defaultRecordingEntitlements,
  ...errors,
};
