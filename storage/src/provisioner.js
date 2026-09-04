// ─────────────────────────────────────────────────────────────────────────────
// BUCKET PROVISIONING (T-202)
//
// Applies and verifies the bucket policy built in bucket-config.js: private
// bucket, 48h incomplete-multipart abort, and browser-direct CORS.
//
// DETECTION FIRST, like T-106. `check()` performs no writes and is what the
// operator (and CI) runs; `apply()` is explicit. Provisioning a bucket is not
// something to do as a side effect of running a report.
//
// THREE-VALUED RESULTS, not two. Every step reports ok | mismatch | unsupported
// | failed. The distinction matters because the local MinIO does NOT implement
// PutBucketCors, and rejects AbortIncompleteMultipartUpload — collapsing that
// into "pass" would claim verification we do not have, and collapsing it into
// "fail" would make a correct configuration look broken on a developer's
// machine. Unsupported means "this backend cannot answer", and the caller is
// told to verify against R2.
//
// This module is the only place that names S3 bucket-configuration commands.
// Application code never provisions storage; this is operator tooling.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const {
  PutBucketCorsCommand, GetBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyStatusCommand, HeadBucketCommand,
} = require('@aws-sdk/client-s3');

const {
  buildCorsConfiguration, buildLifecycleConfiguration, assertNoDurableExpiry,
  RULE_ID, ABORT_INCOMPLETE_MULTIPART_DAYS,
} = require('./bucket-config');
const { mapStorageError } = require('./errors');

const STATUS = { ok: 'ok', mismatch: 'mismatch', unsupported: 'unsupported', failed: 'failed', absent: 'absent' };

// S3 error codes meaning "this backend does not implement the call" as opposed
// to "the call failed". Kept explicit so a genuine failure is never excused.
const NOT_IMPLEMENTED = new Set(['NotImplemented', 'MethodNotAllowed', 'InvalidRequest']);
const NOT_CONFIGURED = new Set(['NoSuchCORSConfiguration', 'NoSuchLifecycleConfiguration']);

function codeOf(err) { return (err && (err.Code || err.name)) || null; }

class ProvisionReport {
  constructor(bucket, mode) {
    this.bucket = bucket;
    this.mode = mode;
    this.steps = [];
  }

  add(step, status, detail, extra = {}) {
    this.steps.push({ step, status, detail, ...extra });
    return this;
  }

  get ok() { return this.steps.every((s) => s.status === STATUS.ok || s.status === STATUS.unsupported); }
  get unsupported() { return this.steps.filter((s) => s.status === STATUS.unsupported); }
  get problems() {
    return this.steps.filter((s) => s.status === STATUS.mismatch || s.status === STATUS.failed
      || s.status === STATUS.absent);
  }

  format() {
    const icon = { ok: '  OK  ', mismatch: ' DIFF ', unsupported: ' N/A  ', failed: ' FAIL ', absent: ' NONE ' };
    const lines = [
      '',
      `── BUCKET POLICY ${this.mode === 'apply' ? 'APPLY' : 'CHECK (read-only)'} — ${this.bucket} ───────────────`,
      '',
    ];
    for (const s of this.steps) {
      lines.push(`  [${icon[s.status] || s.status}] ${s.step}`);
      if (s.detail) lines.push(`           ${s.detail}`);
    }
    if (this.unsupported.length) {
      lines.push('');
      lines.push('  Some settings could not be verified against this backend. They are NOT');
      lines.push('  confirmed — verify them against R2 (staging) before relying on them.');
    }
    return lines.join('\n');
  }

  toJSON() {
    return {
      bucket: this.bucket, mode: this.mode, ok: this.ok,
      steps: this.steps, unsupported: this.unsupported.map((s) => s.step),
    };
  }
}

/** Compare what we intend against what the bucket reports. Order-insensitive. */
function corsMatches(intended, actual) {
  const want = intended.CORSRules[0];
  const rules = (actual && actual.CORSRules) || [];
  const norm = (a) => [...(a || [])].map((v) => String(v).toLowerCase()).sort().join(',');
  return rules.some((r) => norm(r.AllowedOrigins) === norm(want.AllowedOrigins)
    && norm(r.AllowedMethods) === norm(want.AllowedMethods)
    && norm(r.ExposeHeaders) === norm(want.ExposeHeaders));
}

function lifecycleFindings(actual) {
  const rules = (actual && actual.Rules) || [];
  const abort = rules.find((r) => r.AbortIncompleteMultipartUpload);
  const expiry = rules.find((r) => r.ID === RULE_ID.expireUploadsTmp);
  return {
    abortPresent: !!abort,
    abortDays: abort && abort.AbortIncompleteMultipartUpload
      ? abort.AbortIncompleteMultipartUpload.DaysAfterInitiation : null,
    expiryPresent: !!expiry,
    rules,
  };
}

/**
 * Check or apply the bucket policy.
 *
 * @param {object} opts
 * @param {import('@aws-sdk/client-s3').S3Client} opts.client
 * @param {object} opts.config resolved storage config (bucket, corsOrigins, …)
 * @param {'check'|'apply'} [opts.mode]
 * @returns {Promise<ProvisionReport>}
 */
async function provisionBucket({ client, config, mode = 'check' }) {
  const bucket = config.bucket;
  const report = new ProvisionReport(bucket, mode);

  // ── 0. The bucket must exist. We never create it: creating a production
  // bucket implicitly, with defaults nobody reviewed, is not something a tool
  // should do on its own.
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    report.add('bucket exists', STATUS.ok, bucket);
  } catch (err) {
    report.add('bucket exists', STATUS.failed,
      `${bucket} is not reachable (${codeOf(err) || 'unknown'}) — create it first; this tool never creates buckets`);
    return report;
  }

  // ── 1. The bucket must be PRIVATE. Every read goes through a signed URL.
  try {
    const status = await client.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }));
    const isPublic = !!(status.PolicyStatus && status.PolicyStatus.IsPublic);
    report.add('bucket is private', isPublic ? STATUS.failed : STATUS.ok,
      isPublic ? 'BUCKET IS PUBLIC — all media is world-readable; fix before any upload' : 'not publicly readable');
  } catch (err) {
    const code = codeOf(err);
    if (NOT_IMPLEMENTED.has(code)) {
      report.add('bucket is private', STATUS.unsupported, `backend does not implement GetBucketPolicyStatus (${code})`);
    } else if (code === 'NoSuchBucketPolicy') {
      report.add('bucket is private', STATUS.ok, 'no bucket policy — private by default');
    } else {
      report.add('bucket is private', STATUS.failed, `could not determine public status (${code || 'unknown'})`);
    }
  }

  // ── 2. Lifecycle: 48h incomplete-multipart abort + uploads-tmp expiry.
  const intendedLifecycle = buildLifecycleConfiguration();
  assertNoDurableExpiry(intendedLifecycle.Rules); // belt and braces before any write
  if (mode === 'apply') {
    try {
      await client.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket, LifecycleConfiguration: intendedLifecycle,
      }));
      report.add('lifecycle applied', STATUS.ok,
        `abort incomplete multipart after ${ABORT_INCOMPLETE_MULTIPART_DAYS}d; expire uploads-tmp/`);
    } catch (err) {
      const code = codeOf(err);
      report.add('lifecycle applied',
        NOT_IMPLEMENTED.has(code) || code === 'InvalidArgument' ? STATUS.unsupported : STATUS.failed,
        `${code || 'unknown'} — this backend rejected the lifecycle configuration`);
    }
  }
  let actualLifecycle = null;
  try {
    actualLifecycle = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  } catch (err) {
    const code = codeOf(err);
    if (NOT_CONFIGURED.has(code)) {
      report.add('lifecycle configured', STATUS.absent, 'no lifecycle configuration on the bucket');
    } else if (NOT_IMPLEMENTED.has(code)) {
      report.add('lifecycle configured', STATUS.unsupported, `backend does not implement lifecycle reads (${code})`);
    } else {
      report.add('lifecycle configured', STATUS.failed, `${code || 'unknown'}`);
    }
  }
  if (actualLifecycle) {
    const f = lifecycleFindings(actualLifecycle);
    // A rule someone added by hand could be expiring durable media right now.
    // Surface the actual reason — an operator needs to know WHICH rule is
    // dangerous, not merely that something failed.
    try {
      assertNoDurableExpiry(f.rules);
      report.add('lifecycle: no durable prefix expires', STATUS.ok,
        'no rule deletes objects outside the temporary namespace');
    } catch (guardErr) {
      report.add('lifecycle: no durable prefix expires', STATUS.failed, guardErr.message);
    }
    report.add('lifecycle: abort incomplete multipart',
      f.abortPresent && f.abortDays === ABORT_INCOMPLETE_MULTIPART_DAYS ? STATUS.ok : STATUS.mismatch,
      f.abortPresent ? `abort after ${f.abortDays}d (want ${ABORT_INCOMPLETE_MULTIPART_DAYS}d)` : 'rule not present');
    report.add('lifecycle: uploads-tmp expiry',
      f.expiryPresent ? STATUS.ok : STATUS.mismatch,
      f.expiryPresent ? 'uploads-tmp/ expires' : 'rule not present');
  }

  // ── 3. CORS for browser-direct uploads.
  // A rejected CORS configuration must be a REPORTED step, not an exception:
  // throwing here would discard the lifecycle results already gathered (and,
  // in apply mode, already written), leaving the operator with no report at
  // all for work that did happen.
  let intendedCors = null;
  try {
    intendedCors = buildCorsConfiguration(config);
  } catch (cfgErr) {
    report.add('CORS configuration valid', STATUS.failed, cfgErr.message);
    return report;
  }
  if (mode === 'apply') {
    try {
      await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: intendedCors }));
      report.add('CORS applied', STATUS.ok, intendedCors.CORSRules[0].AllowedOrigins.join(', '));
    } catch (err) {
      const code = codeOf(err);
      report.add('CORS applied', NOT_IMPLEMENTED.has(code) ? STATUS.unsupported : STATUS.failed,
        `${code || 'unknown'} — this backend does not accept a bucket CORS policy`);
    }
  }
  try {
    const actual = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    const match = corsMatches(intendedCors, actual);
    report.add('CORS matches intended policy', match ? STATUS.ok : STATUS.mismatch,
      match ? intendedCors.CORSRules[0].AllowedOrigins.join(', ')
        : 'bucket CORS differs from the configured origins/methods/exposed headers');
  } catch (err) {
    const code = codeOf(err);
    if (NOT_CONFIGURED.has(code)) {
      report.add('CORS configured', STATUS.absent, 'no CORS configuration on the bucket');
    } else if (NOT_IMPLEMENTED.has(code)) {
      report.add('CORS configured', STATUS.unsupported, `backend does not implement bucket CORS (${code})`);
    } else {
      report.add('CORS configured', STATUS.failed, `${code || 'unknown'}`);
    }
  }

  return report;
}

module.exports = { provisionBucket, ProvisionReport, STATUS, corsMatches, lifecycleFindings };
