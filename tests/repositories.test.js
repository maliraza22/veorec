// T-103 repository-layer tests (run: cd db && npm run test:repos)
//
// Integration tests against a REAL PostgreSQL — mocks cannot prove ownership
// predicates, constraint behaviour, transaction semantics or row locking.
// Covers: CRUD, ownership scoping, cross-user prevention, not-found, conflict,
// constraint failures, transaction commit/rollback, concurrency, optional
// fields and timestamps.
//
// Runs against APP_ENV=test → DATABASE_URL_TEST and RESETS that database.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const DB_DIR = path.join(__dirname, '..', 'db');

const {
  loadEnv, createPool, checkConnection, createClient,
  createRepositories, withTransaction,
  NotFoundError, ConflictError, ConstraintViolationError, InvalidStateError, ScopeError,
  newId,
} = require(path.join(DB_DIR, 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Assert that `fn` rejects with `ErrClass`. */
async function throws(fn, ErrClass, label) {
  try { await fn(); ok(false, `${label} (expected ${ErrClass.name}, resolved instead)`); }
  catch (e) {
    ok(e instanceof ErrClass, `${label} (got ${e.constructor.name}${e.code ? '/' + e.code : ''}, wanted ${ErrClass.name})`);
  }
}

async function main() {
  const env = loadEnv({ appEnv: 'test' });
  const probe = await checkConnection(createPool({ env, max: 1 }));
  if (!probe.ok) {
    const msg = `database unreachable at ${env.databaseUrlRedacted}: ${probe.error && probe.error.message}`;
    if (process.env.DB_TESTS_REQUIRED === '1') { console.log('  FAIL:', msg); console.log('\n0 passed, 1 failed'); process.exit(1); }
    console.log('\n' + '='.repeat(72));
    console.log('SKIPPED: repository tests — ' + msg);
    console.log('Start infrastructure with:  docker compose up -d postgres');
    console.log('='.repeat(72));
    process.exit(0);
  }
  ok(probe.database !== 'veorec', 'tests do NOT run against the development database');

  const reset = spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reset.js')], {
    cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8',
  });
  ok(reset.status === 0, `clean database prepared\n${reset.stderr || ''}`);

  const pool = createPool({ env, max: 6, applicationName: 'veorec-repo-test' });
  const client = createClient(pool);
  const repos = createRepositories(client);
  const SYS = 'repository test';

  try {
    // ── Users: CRUD, projections, conflict, case-insensitivity ──────────────
    const alice = await repos.users.create({ email: 'Alice@Example.com', name: 'Alice', passwordHash: 'hash-a' });
    const bob = await repos.users.create({ email: 'bob@example.com', name: 'Bob', passwordHash: 'hash-b' });
    ok(alice.id.startsWith('usr_'), 'create() generates a prefixed id');
    ok(alice.passwordHash === undefined, 'default projection never returns the password hash');
    ok(alice.hasPassword === true, 'projection exposes hasPassword instead');
    ok((await repos.users.findByEmail('ALICE@example.com'))?.id === alice.id,
      'findByEmail is case-insensitive (citext)');
    ok((await repos.users.findByEmailWithSecrets('alice@example.com')).passwordHash === 'hash-a',
      'the explicit *WithSecrets read returns the hash for sign-in');
    ok(await repos.users.findById('usr_nope') === null, 'findById returns null for an unknown id');
    await throws(() => repos.users.create({ email: 'alice@example.com', name: 'Dup' }),
      ConflictError, 'duplicate email raises ConflictError');

    const scopeA = { userId: alice.id };
    const scopeB = { userId: bob.id };

    // ── Scope validation ────────────────────────────────────────────────────
    await throws(() => repos.recordings.get(null, 'rec_x'), ScopeError, 'a missing scope is rejected');
    await throws(() => repos.recordings.get({}, 'rec_x'), ScopeError, 'a scope without userId is rejected');
    await throws(() => repos.recordings.getSystem('rec_x'), ScopeError, 'unscoped *System calls require a stated reason');

    // ── Users: self-update scoping ──────────────────────────────────────────
    const renamed = await repos.users.updateSelf(scopeA, { name: 'Alice A.' });
    ok(renamed.name === 'Alice A.', 'updateSelf applies whitelisted fields');
    const ignored = await repos.users.updateSelf(scopeA, { isAdmin: true, id: bob.id });
    ok(ignored.isAdmin === false && ignored.id === alice.id,
      'updateSelf ignores non-whitelisted fields (no privilege escalation)');
    ok((await repos.users.updateAsAdmin(bob.id, { isAdmin: true }, 'admin grant')).isAdmin === true,
      'updateAsAdmin can change privileged fields with a reason');
    await repos.users.updateAsAdmin(bob.id, { isAdmin: false }, 'revert');

    // ── Folders: CRUD + cross-user isolation ────────────────────────────────
    const folderA = await repos.folders.create(scopeA, { name: 'Demos' });
    ok(folderA.userId === alice.id, 'folder is created inside the caller scope');
    ok((await repos.folders.list(scopeB)).length === 0, "another user cannot see Alice's folders");
    ok(await repos.folders.get(scopeB, folderA.id) === null, "cross-user folder read returns null");
    await throws(() => repos.folders.rename(scopeB, folderA.id, 'Hacked'),
      NotFoundError, 'cross-user folder rename raises NotFoundError');
    await throws(() => repos.folders.create(scopeA, { name: 'demos' }),
      ConflictError, 'folder names are unique per user, case-insensitively');

    // ── Recordings: CRUD, whitelist, scoping, counts ────────────────────────
    const rec = await repos.recordings.create(scopeA, { title: 'First', folderId: folderA.id });
    ok(rec.id.startsWith('rec_') && rec.status === 'recording', 'recording created with lifecycle default');
    ok(rec.privacy === 'unlisted', 'privacy defaults to unlisted (docs/12)');
    ok(rec.duration === null && rec.sizeBytes === null, 'unverified media facts start NULL');
    ok(rec.tags.length === 0 && typeof rec.audience === 'object', 'array/jsonb defaults materialise');

    const updated = await repos.recordings.update(scopeA, rec.id, { title: 'Renamed', archived: true });
    ok(updated.title === 'Renamed' && updated.archived === true, 'owner update applies whitelisted fields');
    const guarded = await repos.recordings.update(scopeA, rec.id, { status: 'ready', duration: '999', userId: bob.id });
    ok(guarded.status === 'recording' && guarded.duration === null && guarded.userId === alice.id,
      'owner update cannot set lifecycle, verified media facts or ownership');

    ok(await repos.recordings.get(scopeB, rec.id) === null, "another user cannot read Alice's recording");
    await throws(() => repos.recordings.update(scopeB, rec.id, { title: 'Hacked' }),
      NotFoundError, 'cross-user recording update raises NotFoundError');
    await throws(() => repos.recordings.softDelete(scopeB, rec.id),
      NotFoundError, 'cross-user recording delete raises NotFoundError');
    ok((await repos.recordings.list(scopeB)).length === 0, 'listing is scoped to the caller');

    // System (worker) path may set verified facts.
    const probed = await repos.recordings.updateSystem(rec.id, { status: 'ready', duration: '12.500', width: 1920 }, 'probe worker');
    ok(probed.status === 'ready' && Number(probed.duration) === 12.5 && probed.width === 1920,
      'system update writes FFprobe-verified facts');
    ok((await repos.recordings.countActive(scopeA)) === 1, 'countActive counts live recordings');
    ok((await repos.recordings.getForPublicWatch(rec.id))?.id === rec.id,
      'public watch read resolves without a scope (authorisation happens above)');

    // ── Assets: ownership through the join ──────────────────────────────────
    const asset = await repos.assets.createSystem({
      recordingId: rec.id, kind: 'source', storageKey: `sources/${rec.id}/source.webm`,
      status: 'ready', sizeBytes: 1024,
    }, 'upload complete');
    ok(asset.immutable === true && asset.countsTowardQuota === true,
      'source assets default to immutable and quota-counting');
    const derived = await repos.assets.createSystem({
      recordingId: rec.id, kind: 'mp4', storageKey: `derived/${rec.id}/video.mp4`, status: 'ready',
    }, 'transcode');
    ok(derived.countsTowardQuota === false, 'derived renditions never bill the user');
    ok((await repos.assets.listForRecording(scopeA, rec.id)).length === 2, 'owner sees both assets');
    ok((await repos.assets.listForRecording(scopeB, rec.id)).length === 0,
      'cross-user asset listing returns nothing (ownership enforced by join)');

    // ── Uploads: sessions, idempotency, parts, reservations ─────────────────
    const session = await repos.uploads.createSession(scopeA, {
      recordingId: rec.id, storageKey: `sources/${rec.id}/source.webm`, partSize: 8388608,
      byteCeiling: 536870912, idempotencyKey: 'idem-1', expiresAt: new Date(Date.now() + 3600e3),
    });
    ok(session.status === 'pending' && session.byteCeiling === 536870912, 'upload session stores the byte ceiling');
    ok((await repos.uploads.findByIdempotencyKey(scopeA, 'idem-1'))?.id === session.id,
      'session is retrievable by idempotency key (retry-safe creation)');
    await throws(() => repos.uploads.createSession(scopeA, {
      recordingId: rec.id, storageKey: 'x', partSize: 8388608, byteCeiling: 1,
      idempotencyKey: 'idem-2', expiresAt: new Date(),
    }), ConflictError, 'only one open upload session per recording');
    ok(await repos.uploads.getSession(scopeB, session.id) === null, "cross-user session read returns null");

    await repos.uploads.recordPart(scopeA, session.id, { partNumber: 1, size: 8388608, etag: 'e1' });
    await repos.uploads.recordPart(scopeA, session.id, { partNumber: 1, size: 8388608, etag: 'e1-retry' });
    const parts = await repos.uploads.listParts(scopeA, session.id);
    ok(parts.length === 1 && parts[0].etag === 'e1-retry', 're-recording a part upserts instead of duplicating');
    ok((await repos.uploads.sumPartBytes(scopeA, session.id)) === 8388608, 'uploaded byte total is derived from parts');
    await throws(() => repos.uploads.listParts(scopeB, session.id),
      NotFoundError, 'cross-user part listing raises NotFoundError');

    const reservation = await repos.uploads.createReservation(scopeA, {
      uploadSessionId: session.id, reservedBytes: 536870912, expiresAt: new Date(Date.now() + 3600e3),
    });
    ok(reservation.status === 'held', 'reservation starts held');
    await throws(() => repos.uploads.createReservation(scopeA, {
      uploadSessionId: session.id, reservedBytes: 1, expiresAt: new Date(),
    }), ConflictError, 'only one open reservation per upload session');
    await throws(() => repos.uploads.createReservation(scopeA, { reservedBytes: 1, expiresAt: new Date() }),
      ConstraintViolationError, 'a reservation must belong to an upload or a render');
    const settled = await repos.uploads.settleReservation(scopeA, reservation.id, 'reconciled', { reconciledBytes: 4096 });
    ok(settled.status === 'reconciled' && settled.reconciledBytes === 4096, 'reservation settles with the real size');
    await throws(() => repos.uploads.settleReservation(scopeA, reservation.id, 'released'),
      NotFoundError, 'a settled reservation cannot be settled twice');

    // ── Usage ledger ────────────────────────────────────────────────────────
    await repos.usage.ensure(scopeA);
    await repos.usage.ensure(scopeA);
    ok((await repos.usage.get(scopeA)).storageRetainedBytes === 0, 'ensure() is idempotent and starts at zero');
    const afterDelta = await repos.usage.applyDelta(scopeA, { storageRetainedBytes: 4096, activeVideoCount: 1 });
    ok(afterDelta.storageRetainedBytes === 4096 && afterDelta.activeVideoCount === 1, 'applyDelta increments counters');
    await throws(() => repos.usage.applyDelta(scopeA, { activeVideoCount: -5 }),
      ConstraintViolationError, 'the ledger refuses to go negative');
    await throws(() => repos.usage.getForUpdate(scopeA),
      InvalidStateError, 'getForUpdate refuses to run outside a transaction');

    // ── Transactions: commit and rollback ───────────────────────────────────
    await withTransaction(async (tx) => {
      await tx.usage.applyDelta(scopeA, { storageRetainedBytes: 1000 });
      await tx.recordings.create(scopeA, { title: 'committed' });
    }, client);
    ok((await repos.usage.get(scopeA)).storageRetainedBytes === 5096, 'committed transaction persists every write');

    let rolledBack = false;
    try {
      await withTransaction(async (tx) => {
        await tx.usage.applyDelta(scopeA, { storageRetainedBytes: 50000 });
        await tx.recordings.create(scopeA, { title: 'never persisted' });
        throw new Error('boom');
      }, client);
    } catch { rolledBack = true; }
    ok(rolledBack, 'a throwing transaction propagates the error');
    ok((await repos.usage.get(scopeA)).storageRetainedBytes === 5096, 'rollback discards the ledger write');
    const titles = (await repos.recordings.list(scopeA, { archived: false })).map((r) => r.title);
    ok(!titles.includes('never persisted'), 'rollback discards the inserted row');

    ok((await withTransaction(async (tx) => {
      const row = await tx.usage.getForUpdate(scopeA);
      return row && typeof row.storageReservedBytes === 'number';
    }, client)) === true, 'getForUpdate works inside a transaction (row lock for T-306)');

    // ── Concurrency: the row lock prevents double-spending quota ────────────
    // Mirrors the T-306 pattern: lock → read → decide → write. With a 1000-byte
    // budget and two concurrent 600-byte reservations, exactly one may succeed.
    const LIMIT = 1000, WANT = 600;
    await repos.usage.applyDelta(scopeA, { storageReservedBytes: 0 });
    const attempt = async (delayMs) => withTransaction(async (tx) => {
      const row = await tx.usage.getForUpdate(scopeA);
      await sleep(delayMs);                                   // widen the race window
      if (Number(row.storageReservedBytes) + WANT > LIMIT) return 'rejected';
      await tx.usage.applyDelta(scopeA, { storageReservedBytes: WANT });
      return 'granted';
    }, client);
    const outcomes = await Promise.all([attempt(120), attempt(0)]);
    ok(outcomes.filter((o) => o === 'granted').length === 1 && outcomes.includes('rejected'),
      `exactly one of two concurrent reservations succeeds (got ${outcomes.join(', ')})`);
    ok((await repos.usage.get(scopeA)).storageReservedBytes === WANT,
      'the ledger reflects exactly one reservation — no double-spend');

    // ── Jobs: idempotent enqueue, lifecycle ─────────────────────────────────
    const first = await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${rec.id}`, recordingId: rec.id });
    const again = await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${rec.id}`, recordingId: rec.id });
    ok(first.created === true && again.created === false && again.job.id === first.job.id,
      'enqueue is idempotent on dedupe_key');
    const active = await repos.jobs.markActiveSystem(first.job.id, 'worker');
    ok(active.status === 'active' && active.attempts === 1, 'marking active increments the attempt counter');
    ok((await repos.jobs.markFailedSystem(first.job.id, 'ffmpeg exploded', 'worker')).status === 'queued',
      'a retryable failure returns the job to the queue');
    ok((await repos.jobs.markFailedSystem(first.job.id, 'give up', 'worker', { terminal: true })).status === 'failed',
      'a terminal failure marks the job failed (dead letter)');
    ok((await repos.jobs.listForRecording(scopeA, rec.id)).length === 1, 'jobs are listable within the owner scope');
    ok((await repos.jobs.listForRecording(scopeB, rec.id)).length === 0, 'cross-user job listing returns nothing');

    // ── Billing: replay-proof webhook ledger ────────────────────────────────
    const evt = { paddleEventId: 'evt_1', eventType: 'subscription.created', payload: { a: 1 } };
    const e1 = await repos.billingEvents.recordIfNew(evt);
    const e2 = await repos.billingEvents.recordIfNew(evt);
    ok(e1.created === true && e2.created === false && e2.event.id === e1.event.id,
      'a duplicate Paddle event id is recorded once (replay defence)');
    await repos.billingEvents.markProcessed(e1.event.id);
    const sub = await repos.subscriptions.upsertForUserSystem(alice.id,
      { planSlug: 'pro', status: 'active', billingCycle: 'monthly' }, 'webhook');
    ok(sub.planSlug === 'pro', 'subscription upserted for the user');
    const sub2 = await repos.subscriptions.upsertForUserSystem(alice.id,
      { planSlug: 'pro', status: 'canceled', billingCycle: 'monthly' }, 'webhook');
    ok(sub2.id === sub.id && sub2.status === 'canceled', 'a second webhook updates the same subscription row');
    ok((await repos.subscriptions.getForUser(scopeB)) === null, 'subscription reads are scoped to the user');

    // ── Engagement ──────────────────────────────────────────────────────────
    const comment = await repos.comments.addForViewer(rec.id, { authorName: 'Viewer', body: 'nice', t: '3.500' });
    await repos.comments.addForViewer(rec.id, { authorName: 'Viewer2', body: 'reply', parentId: comment.id });
    ok((await repos.comments.listForRecording(rec.id)).length === 2, 'viewers can comment without a scope');
    await throws(() => repos.comments.softDeleteAsOwner(scopeB, comment.id),
      NotFoundError, 'only the recording owner can moderate its comments');
    await repos.comments.softDeleteAsOwner(scopeA, comment.id);
    ok((await repos.comments.listForRecording(rec.id)).length === 1, 'moderated comments disappear from listings');

    await repos.viewSessions.recordView(rec.id, { viewerKey: 'v:visitor-1' });
    await repos.viewSessions.recordView(rec.id, { viewerKey: 'v:visitor-1' });
    await repos.viewSessions.recordView(rec.id, { viewerKey: 'u:' + alice.id, viewerUserId: alice.id, isOwner: true });
    ok((await repos.viewSessions.countUnique(rec.id)) === 1,
      'repeat views collapse to one unique viewer and owner views are excluded');
    await repos.viewSessions.recordProgress(rec.id, 'v:visitor-1', 0.95);
    await repos.viewSessions.recordProgress(rec.id, 'v:visitor-1', 0.2);
    const stats = await repos.viewSessions.statsForOwner(scopeA, rec.id);
    ok(stats.completed === 1 && Number(stats.avgProgress) > 0.9,
      'watch progress is monotonic — a later, lower beacon cannot regress it');
    await throws(() => repos.viewSessions.statsForOwner(scopeB, rec.id),
      NotFoundError, 'analytics are readable only by the recording owner');

    const lead1 = await repos.leads.capture(rec.id, { email: 'lead@example.com', name: 'Lead' });
    const lead2 = await repos.leads.capture(rec.id, { email: 'lead@example.com' });
    ok(lead1 && lead2 === null, 'lead capture is idempotent per (recording, email)');
    ok((await repos.leads.listForOwner(scopeA, rec.id)).length === 1, 'owner can list captured leads');

    const link = await repos.shareLinks.create(scopeA, rec.id, { tokenHash: 'hash-1', label: 'client' });
    ok((await repos.shareLinks.findByTokenHashForWatch('hash-1'))?.id === link.id, 'share link resolves by token hash');
    await throws(() => repos.shareLinks.create(scopeB, rec.id, { tokenHash: 'h2' }),
      NotFoundError, 'cannot create a share link on a recording you do not own');
    ok((await repos.shareLinks.revoke(scopeA, link.id)).revokedAt !== null, 'owner can revoke a share link');

    // ── Transcripts: atomic segment replacement ─────────────────────────────
    const transcript = await repos.transcripts.upsertSystem(rec.id,
      { status: 'done', language: 'en', text: 'hello world', source: 'groq' }, 'stt worker');
    ok(transcript.status === 'done', 'transcript upserted by the worker');
    await throws(() => repos.transcripts.replaceSegmentsSystem(transcript.id, [], 'stt worker'),
      InvalidStateError, 'segment replacement refuses to run outside a transaction');
    await withTransaction(async (tx) => {
      await tx.transcripts.replaceSegmentsSystem(transcript.id, [
        { start: 0, end: 1.5, text: 'hello', language: 'en' },
        { start: 1.5, end: 3, text: 'world', language: 'en' },
      ], 'stt worker');
    }, client);
    ok((await repos.transcripts.listSegments(transcript.id)).length === 2, 'segments written atomically');
    await withTransaction(async (tx) => {
      await tx.transcripts.replaceSegmentsSystem(transcript.id, [{ start: 0, end: 1, text: 'only' }], 'stt worker');
    }, client);
    const segs = await repos.transcripts.listSegments(transcript.id);
    ok(segs.length === 1 && segs[0].text === 'only', 'replacement removes the previous segment set');
    ok((await repos.transcripts.getForRecording(scopeB, rec.id)) === null, 'transcript reads are ownership-scoped');
    await repos.transcripts.putTranslationSystem(transcript.id, 'ur', [{ text: 'ہیلو' }], 'translate worker');
    ok((await repos.transcripts.getTranslation(transcript.id, 'ur')) !== null, 'translations are cached per language');

    // ── Audit ───────────────────────────────────────────────────────────────
    await repos.audit.record({ actorUserId: alice.id, action: 'recording.delete', targetType: 'recording', targetId: rec.id });
    ok((await repos.audit.listAsAdmin({ action: 'recording.delete' }, 'admin review')).length === 1,
      'audit entries are recorded and queryable');

    // ── Timestamps ──────────────────────────────────────────────────────────
    const before = await repos.recordings.get(scopeA, rec.id);
    await sleep(10);
    const after = await repos.recordings.update(scopeA, rec.id, { title: 'Timestamp check' });
    ok(before.createdAt.getTime() === after.createdAt.getTime(), 'created_at is immutable across updates');
    ok(after.updatedAt.getTime() > before.updatedAt.getTime(), 'updated_at advances on update (database trigger)');

    // ── Soft delete removes the row from scoped reads ───────────────────────
    await repos.recordings.softDelete(scopeA, rec.id);
    ok(await repos.recordings.get(scopeA, rec.id) === null, 'soft-deleted recordings vanish from scoped reads');
    ok(await repos.recordings.getForPublicWatch(rec.id) === null, 'soft-deleted recordings are unavailable publicly');
    ok((await repos.recordings.getSystem(rec.id, 'cleanup job')) !== null,
      'the cleanup worker can still see soft-deleted rows');
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
