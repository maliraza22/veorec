// T-1103 AI status surfaces + retry UI (run: cd server && npm run test:ai-status)
//
// A. The pure status module (client/src/lib/aiStatus.mjs): the docs/18 §8
//    taxonomy → owner copy + retryability, the latest-row-per-queue rule, the
//    summary the panel renders (busy / failed / show), poll delay. B. The
//    API's aiBlock projection (api/src/ai.router.js). C. Source-level wiring:
//    the watch page mounts the status hook + panel for the OWNER of a v1
//    recording, retries route to the existing manual triggers, the transcript
//    tab shows the failure reason, the dashboard card carries the AI badge,
//    nothing polls on a timer without a fact to wait for.
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const { aiBlock } = require(path.join(ROOT, 'api', 'src', 'ai.router.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async () => {
  console.log('T-1103 AI status tests');

  console.log('\nA. aiStatus.mjs');
  const S = await import(`file:///${path.join(CLIENT_DIR, 'src', 'lib', 'aiStatus.mjs').replace(/\\/g, '/')}`);
  ok(S.aiFailureCopy('no_speech').retryable === false && /No speech/.test(S.aiFailureCopy('no_speech').message), 'no_speech is a valid outcome, not a retry');
  ok(S.aiFailureCopy('rate_limited').retryable === true && S.aiFailureCopy('groq_network: fetch failed').retryable === true && /provider/.test(S.aiFailureCopy('groq_error').message), 'provider trouble is retryable (the code before ":" is what counts)');
  ok(S.aiFailureCopy('transcription_unconfigured').retryable === false && S.aiFailureCopy('no_llm').retryable === false && S.aiFailureCopy('recording_gone').retryable === false, 'configuration and gone-recording failures are not retryable');
  ok(S.aiFailureCopy('something_else').message === 'Failed (something_else).' && S.aiFailureCopy(null).message === 'Failed.' && S.aiFailureCopy(null).retryable === true, 'unknown codes are shown verbatim and retryable');
  const jobs = [
    { id: 'job_1', queue: 'ai_title', status: 'failed', error: 'no_llm: x', attempts: 3 },
    { id: 'job_2', queue: 'ai_title', status: 'completed', error: null },
    { id: 'job_3', queue: 'ai_summary', status: 'active', progress: 40 },
    { id: 'job_4', queue: 'ai_chapters', status: 'failed', error: 'rate_limited', attempts: 3 },
    { id: 'job_5', queue: 'probe', status: 'completed' },
    { id: 'job_6', queue: 'captions', status: 'queued' },
  ];
  const latest = S.latestByQueue(jobs);
  ok(latest.ai_title.id === 'job_2' && latest.ai_summary.id === 'job_3' && !latest.probe && Object.keys(latest).length === 4, 'the newest row per AI queue wins; media queues are ignored');
  const sum = S.summarizeAiStatus({ aiStatus: 'running', transcript: { status: 'done', error: null, note: null }, jobs });
  ok(sum.busy === true && sum.failed === 1 && sum.show === true && sum.transcript.state === 'done' && sum.transcript.message === null, 'busy while any AI job runs; one failure counted');
  const byKind = Object.fromEntries(sum.items.map((i) => [i.kind, i]));
  ok(byKind.title.state === 'done' && byKind.summary.state === 'running' && byKind.summary.progress === 40 && byKind.chapters.state === 'failed' && byKind.chapters.retryable === true && /busy/.test(byKind.chapters.message) && byKind.chapters.retryPath === 'chapters' && byKind.captions.state === 'queued' && byKind.captions.retryable === false, 'each item carries its state, progress, message, retryability and the manual trigger that retries it');
  const tf = S.summarizeAiStatus({ aiStatus: 'failed', transcript: { status: 'failed', error: 'audio_decode_failed' }, jobs: [] });
  ok(tf.transcript.state === 'failed' && tf.transcript.retryable === false && /decoded/.test(tf.transcript.message) && tf.failed === 1 && tf.busy === false && tf.show === true, 'a failed transcript is surfaced with its reason');
  const ns = S.summarizeAiStatus({ aiStatus: 'done', transcript: { status: 'done', note: 'no_speech' }, jobs: [] });
  ok(ns.transcript.message === 'No speech was detected.' && ns.show === false, 'the no_speech note is explained; nothing to show when all is done');
  ok(S.summarizeAiStatus(null).show === false && S.summarizeAiStatus({ aiStatus: 'none', transcript: { status: 'none' }, jobs: [] }).show === false, 'no status / no AI work → nothing to show');
  ok(S.aiPollDelay(0) === 3000 && S.aiPollDelay(20) === 6000, 'poll delay 3 s → 6 s');

  console.log('\nB. aiBlock (api)');
  const blk = aiBlock('queued', jobs.map((j) => ({ ...j, progress: j.progress ?? null })));
  ok(blk.status === 'queued' && blk.failed.length === 1 && blk.failed[0].queue === 'ai_chapters' && blk.failed[0].jobId === 'job_4' && blk.active.length === 2 && blk.active.some((a) => a.queue === 'ai_summary' && a.progress === 40), 'the API block lists the latest failed and active AI rows (title\'s newer success hides its older failure)');
  ok(aiBlock(null, []).status === 'none' && aiBlock(null, []).failed.length === 0, 'no jobs → none');

  console.log('\nC. Wiring');
  const watch = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Watch.jsx'), 'utf8');
  const hook = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'watch', 'useAiStatus.js'), 'utf8');
  const panel = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'watch', 'AiStatus.jsx'), 'utf8');
  const dash = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Dashboard.jsx'), 'utf8');
  ok(/useAiStatus\(\{ API, authHeaders, rec, enabled: isV1 && isOwner && pageState === 'ready', busyHint: aiBusyHint \}\)/.test(watch), 'the watch page reads the AI status for the OWNER of a ready v1 recording only');
  ok(/<AiStatusPanel summary=\{aiSummaryState\} onRetry=\{retryAi\}/.test(watch) && /kind === 'transcribe'\) return generateTranscript\(\)/.test(watch) && /kind === 'summary'\) return aiSummary\(\)/.test(watch), 'retries route to the existing manual triggers (202 + poll)');
  ok(/refreshAiStatus\(\);/.test(watch), 'the strip refreshes after an AI action settles');
  ok(/data-testid="transcript-failed"/.test(watch) && /aiFailureCopy\(transcript\.error\)\.message/.test(watch), 'the transcript tab shows the failure reason');
  ok(/\/api\/v1\/recordings\/\$\{encodeURIComponent\(id\)\}\/status/.test(hook) && /if \(!s\.busy && !busyHint\) \{ attempt\.current = 0; return; \}/.test(hook), 'the hook polls only while a fact says work is in flight');
  ok(/data-testid="ai-status"/.test(panel) && /i\.state === 'failed' && i\.retryable && onRetry/.test(panel) && /if \(!summary \|\| !summary\.show\) return null;/.test(panel), 'the panel renders only when there is something to say and offers Retry only where it can help');
  ok(/data-ai-status=\{r\.ai_status\}/.test(dash) && /'AI failed' : 'AI…'/.test(dash), 'the dashboard card carries an AI badge for v1 rows');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
