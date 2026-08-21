/** Measures the active transport: listing, stats, thumbnails, bulk reads. */
import { DeviceSession, findAttachedDevice } from './main/device/session';
import { scanLibrary } from './main/library/scanner';

const since = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e9;

async function main(): Promise<void> {
  const rec = await findAttachedDevice();
  if (!rec) throw new Error('no device');
  const transport = rec.connectionType === 'USB' ? 'USB' : 'Wi-Fi';
  console.log('transport: ' + transport + '\n');

  let t = process.hrtime.bigint();
  const s = await DeviceSession.open(rec);
  console.log('  session opened        ' + (since(t) * 1000).toFixed(0) + ' ms');

  t = process.hrtime.bigint();
  const scan = await scanLibrary(s.pool);
  console.log('  library listed        ' + (since(t) * 1000).toFixed(0) + ' ms  (' +
    scan.assets.length.toLocaleString() + ' items)');

  const files = scan.assets.filter((a) => a.kind !== 'other').slice(0, 120);
  t = process.hrtime.bigint();
  await s.pool.map(files, (afc, a) => afc.stat('/DCIM/' + a.id));
  const statSec = since(t);
  console.log('  metadata              ' + (files.length / statSec).toFixed(0) + ' files/s');

  const stills = scan.assets.filter((a) => a.kind === 'photo').slice(0, 30);
  t = process.hrtime.bigint();
  let thumbBytes = 0;
  await s.pool.map(stills, async (afc, a) => {
    try {
      thumbBytes += (await afc.readFile('/PhotoData/Thumbnails/V2/DCIM/' + a.id + '/5005.JPG')).length;
    } catch { /* missing */ }
  });
  const thumbSec = since(t);
  console.log('  thumbnails            ' + (stills.length / thumbSec).toFixed(0) + '/s  (' +
    (thumbBytes / 1e6 / thumbSec).toFixed(1) + ' MB/s)');

  // Bulk read, bounded: fixed byte budgets so a slow link still finishes.
  const sized = await s.pool.map(
    scan.assets.filter((a) => a.kind === 'video' && !a.motionPart).slice(0, 20),
    async (afc, a) => ({ a, size: (await afc.stat('/DCIM/' + a.id)).size }),
  );
  const big = sized.filter((x): x is { a: (typeof scan.assets)[0]; size: number } =>
    Boolean(x && x.size > 12_000_000)).slice(0, 6);

  const CHUNK = 1024 * 1024;
  const readN = (afc: import('./main/device/afc').AfcClient, id: string, mb: number) =>
    afc.withFile('/DCIM/' + id, async (file) => {
      let got = 0;
      for (let i = 0; i < mb; i++) {
        const b = await file.readAt(i * CHUNK, CHUNK);
        got += b.length;
        if (b.length < CHUNK) break;
      }
      return got;
    });

  if (big.length >= 2) {
    t = process.hrtime.bigint();
    const one = await s.pool.run((afc) => readN(afc, big[0].a.id, 8));
    const oneSec = since(t);
    console.log('  bulk read, 1 stream   ' + (one / 1e6 / oneSec).toFixed(1) + ' MB/s');

    t = process.hrtime.bigint();
    let read = 0;
    await s.pool.map(big, async (afc, f) => { read += await readN(afc, f.a.id, 4); },
      { concurrency: 6 });
    const sixSec = since(t);
    console.log('  bulk read, 6 streams  ' + (read / 1e6 / sixSec).toFixed(1) + ' MB/s');
  }

  s.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
