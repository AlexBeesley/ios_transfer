/**
 * End-to-end check against a real attached device.
 *
 * Drives the same modules the app uses — session, scanner, thumbnail service
 * and transfer engine — and verifies the bytes that land on disk. Run with
 * `npm run e2e`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceSession, findAttachedDevice } from './main/device/session';
import { loadMetadata, scanLibrary, summarize } from './main/library/scanner';
import { ThumbnailService } from './main/library/thumbnails';
import { DurationService } from './main/library/duration';
import { expandSelection, TransferJob } from './main/library/transfer';
import type { TransferProgress } from './shared/types';

const t0 = () => process.hrtime.bigint();
const msSince = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}

/** Skips the heavy bulk copy — checks logic without saturating a disk. */
const quick = process.env.E2E_QUICK === '1';

async function main(): Promise<void> {
  const record = await findAttachedDevice();
  if (!record) throw new Error('no device attached');

  console.log('=== connect ===');
  let t = t0();
  const session = await DeviceSession.open(record);
  const connectMs = msSince(t);
  const { info } = session;
  console.log(
    '  ' + info.name + ' — ' + info.deviceClass + ' ' + info.productType + ', iOS ' +
      info.iosVersion + ', ' + (info.capacityBytes / 1e9).toFixed(0) + ' GB, battery ' +
      info.batteryLevel + '%',
  );
  check('session opens under 3s', connectMs < 3000, connectMs.toFixed(0) + 'ms');
  check('device reports a name', info.name.length > 0);
  check('device reports capacity', info.capacityBytes > 0);

  console.log('\n=== scan ===');
  t = t0();
  const scan = await scanLibrary(session.pool);
  const scanMs = msSince(t);
  console.log('  ' + scan.assets.length + ' assets across ' + scan.folders.length + ' folders');
  check('library listed under 2s', scanMs < 2000, scanMs.toFixed(0) + 'ms');
  check('found assets', scan.assets.length > 0);
  check(
    'live photo pairing detected',
    scan.assets.some((a) => a.live) && scan.assets.some((a) => a.motionPart),
    scan.assets.filter((a) => a.live).length + ' live, ' +
      scan.assets.filter((a) => a.motionPart).length + ' motion parts',
  );
  check('sidecars excluded', !scan.assets.some((a) => a.ext === 'AAE'));

  console.log('\n=== metadata ===');
  const sample = scan.assets.slice(0, 4000);
  let batches = 0;
  t = t0();
  await loadMetadata(session.pool, sample, { onBatch: () => batches++ });
  const metaMs = msSince(t);
  const dated = sample.filter((a) => a.mtime > 0).length;
  const sized = sample.filter((a) => a.size > 0).length;
  console.log(
    '  ' + sample.length + ' in ' + metaMs.toFixed(0) + 'ms = ' +
      (sample.length / (metaMs / 1000)).toFixed(0) + '/s across ' + batches + ' batches',
  );
  check('every sampled asset got a size', sized === sample.length, sized + '/' + sample.length);
  check('every sampled asset got a date', dated === sample.length, dated + '/' + sample.length);
  const stats = summarize(sample);
  console.log('  photos=' + stats.photos + ' videos=' + stats.videos + ' raw=' + stats.raw +
    ' bytes=' + (stats.bytes / 1e9).toFixed(1) + ' GB');

  console.log('\n=== thumbnails ===');
  const cacheDir = path.join(os.tmpdir(), 'ios-transfer-e2e', 'thumbs');
  await fs.promises.rm(cacheDir, { recursive: true, force: true });
  const thumbs = new ThumbnailService(session.pool, cacheDir);

  const stillTargets = sample.filter((a) => a.kind === 'photo').slice(0, 200);
  const videoTargets = sample.filter((a) => a.kind === 'video' && !a.motionPart).slice(0, 60);

  t = t0();
  const stillResults = await Promise.all(stillTargets.map((a) => thumbs.get(a.id, false)));
  const stillMs = msSince(t);
  const stillHits = stillResults.filter((b) => b && b.length > 0).length;
  console.log(
    '  stills: ' + stillHits + '/' + stillTargets.length + ' in ' + stillMs.toFixed(0) + 'ms = ' +
      (stillTargets.length / (stillMs / 1000)).toFixed(0) + '/s',
  );
  check('still thumbnails resolve', stillHits >= stillTargets.length * 0.95);
  check(
    'thumbnails are JPEG',
    stillResults.every((b) => !b || (b[0] === 0xff && b[1] === 0xd8)),
  );

  t = t0();
  const videoResults = await Promise.all(videoTargets.map((a) => thumbs.get(a.id, true)));
  const videoMs = msSince(t);
  const videoHits = videoResults.filter((b) => b && b.length > 0).length;
  console.log(
    '  videos: ' + videoHits + '/' + videoTargets.length + ' in ' + videoMs.toFixed(0) + 'ms',
  );

  // Second pass must be served from cache, not the device.
  t = t0();
  await Promise.all(stillTargets.slice(0, 100).map((a) => thumbs.get(a.id, false)));
  const cachedMs = msSince(t);
  console.log('  cached re-read of 100: ' + cachedMs.toFixed(1) + 'ms');
  check('memory cache is fast', cachedMs < 50, cachedMs.toFixed(1) + 'ms');

  const cachedFiles = await fs.promises
    .readdir(cacheDir, { recursive: true } as never)
    .catch(() => [] as string[]);
  check('thumbnails written to disk cache', (cachedFiles as string[]).length > 0);

  console.log('\n=== video durations ===');
  const durations = new DurationService(session.pool, cacheDir);
  const clips = sample.filter((a) => a.kind === 'video' && !a.motionPart).slice(0, 40);
  const motion = sample.filter((a) => a.motionPart).slice(0, 10);

  t = t0();
  const clipResults = await durations.get(clips.map((a) => ({ id: a.id, size: a.size })));
  const durationMs = msSince(t);
  const resolved = Object.values(clipResults)
    .map((v) => v.seconds)
    .filter((v): v is number => v !== null);
  console.log(
    '  ' + resolved.length + '/' + clips.length + ' clips in ' + durationMs.toFixed(0) + 'ms = ' +
      (clips.length / (durationMs / 1000)).toFixed(0) + '/s',
  );
  console.log(
    '  ' +
      clips
        .slice(0, 6)
        .map((a) => a.name + '=' + (clipResults[a.id]?.seconds?.toFixed(1) ?? 'n/a') + 's')
        .join('  '),
  );
  check(
    'durations resolve for videos',
    resolved.length >= clips.length * 0.9,
    resolved.length + '/' + clips.length,
  );
  check('durations are plausible (0.1s–2h)', resolved.every((d) => d > 0.1 && d < 7200));

  // Live Photo motion files run 1–3 seconds; a good sanity check on the parse.
  if (motion.length > 0) {
    const motionResults = await durations.get(motion.map((a) => ({ id: a.id, size: a.size })));
    const motionSeconds = Object.values(motionResults)
      .map((v) => v.seconds)
      .filter((v): v is number => v !== null);
    console.log('  live motion clips: ' + motionSeconds.map((d) => d.toFixed(1) + 's').join(' '));
    check(
      'live photo motion parts are short',
      motionSeconds.length > 0 && motionSeconds.every((d) => d < 6),
    );
  }

  // A cached lookup must not touch the device at all.
  t = t0();
  await durations.get(clips.map((a) => ({ id: a.id, size: a.size })));
  const cachedDurationMs = msSince(t);
  check('cached durations are instant', cachedDurationMs < 20, cachedDurationMs.toFixed(1) + 'ms');

  console.log('\n=== transfer ===');
  const destination = path.join(os.tmpdir(), 'ios-transfer-e2e', 'out');
  await fs.promises.rm(destination, { recursive: true, force: true });

  // A mix of stills and a few large videos so throughput is meaningful.
  const photos = sample.filter((a) => a.kind === 'photo' && a.size > 0).slice(0, quick ? 5 : 20);
  const videos = sample
    .filter((a) => a.kind === 'video' && a.size > (quick ? 500_000 : 8_000_000))
    .slice(0, quick ? 2 : 4);
  const chosen = [...photos, ...videos];
  const expanded = expandSelection(chosen, sample, true);
  console.log(
    '  selected ' + chosen.length + ' → ' + expanded.length + ' after Live Photo expansion, ' +
      (expanded.reduce((n, a) => n + a.size, 0) / 1e6).toFixed(0) + ' MB',
  );
  check('live expansion adds motion files', expanded.length >= chosen.length);

  const job = new TransferJob('e2e', session.pool, expanded, {
    destination,
    organizeByDate: true,
    includeMotion: true,
    onConflict: 'rename',
    preserveDates: true,
  });

  let peakRate = 0;
  job.on('progress', (p: TransferProgress) => {
    peakRate = Math.max(peakRate, p.bytesPerSecond);
  });

  t = t0();
  const result = await job.run();
  const transferMs = msSince(t);
  console.log(
    '  copied ' + result.filesDone + '/' + result.filesTotal + ' (' +
      (result.bytesDone / 1e6).toFixed(0) + ' MB) in ' + (transferMs / 1000).toFixed(2) + 's = ' +
      (result.bytesDone / 1e6 / (transferMs / 1000)).toFixed(1) + ' MB/s, peak ' +
      (peakRate / 1e6).toFixed(0) + ' MB/s',
  );
  if (result.errors.length) console.log('  errors: ' + JSON.stringify(result.errors.slice(0, 3)));

  check('transfer completed', result.status === 'done', result.status);
  check('no files failed', result.filesFailed === 0, String(result.filesFailed));
  check('all files copied', result.filesDone === result.filesTotal);

  // Verify the bytes actually landed, at the right sizes, in dated folders.
  let verified = 0;
  let sizeMismatch = 0;
  let datesKept = 0;
  let createdKept = 0;
  for (const asset of expanded) {
    const year = asset.mtime ? new Date(asset.mtime).getFullYear() : null;
    const dir = year
      ? path.join(destination, String(year), String(year) + '-' +
          String(new Date(asset.mtime).getMonth() + 1).padStart(2, '0'))
      : path.join(destination, 'Undated');
    const target = path.join(dir, asset.name);
    try {
      const stat = await fs.promises.stat(target);
      verified++;
      if (stat.size !== asset.size) sizeMismatch++;
      if (asset.mtime && Math.abs(stat.mtime.getTime() - asset.mtime) < 2000) datesKept++;
      // Explorer's "Date created" column — the one people sort by.
      if (asset.mtime && Math.abs(stat.birthtime.getTime() - asset.mtime) < 2000) createdKept++;
    } catch {
      /* counted by the check below */
    }
  }
  check('every file exists on disk', verified === expanded.length, verified + '/' + expanded.length);
  check('byte counts match the device', sizeMismatch === 0, sizeMismatch + ' mismatched');
  check('capture dates preserved', datesKept === expanded.length, datesKept + '/' + expanded.length);
  check(
    'Windows "Date created" set to capture time',
    createdKept === expanded.length,
    createdKept + '/' + expanded.length,
  );

  const leftovers = (await fs.promises.readdir(destination, { recursive: true } as never)) as string[];
  check('no .part files left behind', !leftovers.some((f) => f.endsWith('.part')));

  // ---- flat copy with repeated file names -----------------------------------
  // The camera counter wraps past IMG_9999, so the same name recurs in several
  // DCIM folders. Without dated subfolders those all land in one directory.
  console.log('\n=== flat copy with duplicate names ===');
  const flatDestination = path.join(os.tmpdir(), 'ios-transfer-e2e', 'flat');
  await fs.promises.rm(flatDestination, { recursive: true, force: true });

  const groups = new Map<string, typeof scan.assets>();
  for (const asset of scan.assets) {
    const list = groups.get(asset.name) ?? [];
    list.push(asset);
    groups.set(asset.name, list);
  }
  const repeated = [...groups.values()].filter((g) => g.length > 1).slice(0, 300);
  console.log('  library has ' + [...groups.values()].filter((g) => g.length > 1).length +
    ' names used more than once');

  // Take a few duplicate groups, sized so the copy stays quick.
  const flatPick: typeof scan.assets = [];
  for (const group of repeated) {
    if (flatPick.length >= 9) break;
    await session.pool.map(group, async (afc, asset) => {
      if (!asset.size) asset.size = (await afc.stat('/DCIM/' + asset.id)).size;
    });
    if (group.every((a) => a.size > 0 && a.size < 6_000_000)) flatPick.push(...group);
  }

  if (flatPick.length >= 2) {
    const distinctNames = new Set(flatPick.map((a) => a.name)).size;
    console.log('  copying ' + flatPick.length + ' files sharing ' + distinctNames + ' names');

    const flatJob = new TransferJob('e2e-flat', session.pool, flatPick, {
      destination: flatDestination,
      organizeByDate: false,
      includeMotion: false,
      onConflict: 'rename',
      preserveDates: true,
    });
    const flatResult = await flatJob.run();

    const landed = (await fs.promises.readdir(flatDestination)) as string[];
    const landedBytes = (
      await Promise.all(landed.map((f) => fs.promises.stat(path.join(flatDestination, f))))
    ).reduce((n, s) => n + s.size, 0);
    const expectedBytes = flatPick.reduce((n, a) => n + a.size, 0);

    console.log('  ' + landed.length + ' files on disk: ' + landed.slice(0, 6).join(', '));
    check('flat copy kept every file', landed.length === flatPick.length,
      landed.length + '/' + flatPick.length);
    check('nothing was silently skipped', flatResult.filesSkipped === 0,
      String(flatResult.filesSkipped));
    check('flat copy byte total matches', landedBytes === expectedBytes,
      landedBytes + ' vs ' + expectedBytes);
    check('no subdirectories were created',
      landed.every((f) => path.extname(f) !== ''));
  } else {
    console.log('  (no suitable duplicate group found to test)');
  }

  // ---- resuming an interrupted copy ----------------------------------------
  // Re-running the same copy must step over what already arrived rather than
  // duplicating it, otherwise a cancelled transfer can never be restarted.
  console.log('\n=== resume an interrupted copy ===');
  if (flatPick.length >= 2) {
    const before = (await fs.promises.readdir(flatDestination)).length;

    const resumeJob = new TransferJob('e2e-resume', session.pool, flatPick, {
      destination: flatDestination,
      organizeByDate: false,
      includeMotion: false,
      onConflict: 'rename',
      preserveDates: true,
    });
    const resumed = await resumeJob.run();
    const after = (await fs.promises.readdir(flatDestination)).length;

    console.log(
      '  re-ran ' + flatPick.length + ' files: ' + resumed.filesDone + ' copied, ' +
        resumed.filesSkipped + ' recognised as already there',
    );
    console.log(
      '  write streams chosen: ' + resumed.writeStreams + ' (' + resumed.mediaKind + ')',
    );
    check('resume copies nothing again', resumed.filesDone === 0, String(resumed.filesDone));
    check(
      'resume skips every file',
      resumed.filesSkipped === flatPick.length,
      resumed.filesSkipped + '/' + flatPick.length,
    );
    check('resume creates no duplicates', after === before, before + ' -> ' + after);
  } else {
    console.log('  (skipped — no duplicate group available)');
  }

  session.close();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log('output kept at ' + destination);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
