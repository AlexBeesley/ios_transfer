/**
 * Connection diagnostics.
 *
 * Walks the same path the app takes — USB service, device enumeration, pairing,
 * lockdown session, AFC, thumbnails, throughput — and reports where it stops.
 * Run with `npm run doctor`.
 */
import { AfcClient } from './main/device/afc';
import { LockdownClient, loadPairRecord } from './main/device/lockdown';
import { listDevices } from './main/device/usbmux';
import { DeviceSession, findAttachedDevice } from './main/device/session';
import { scanLibrary } from './main/library/scanner';

const ok = (label: string, detail = '') => console.log('  [ok]   ' + label + (detail ? ' — ' + detail : ''));
const bad = (label: string, detail = '') => console.log('  [FAIL] ' + label + (detail ? ' — ' + detail : ''));
const note = (text: string) => console.log('         ' + text);

async function main(): Promise<void> {
  console.log('iOS Transfer — connection check\n');

  // 1. USB service
  let devices;
  try {
    devices = await listDevices();
    ok('Apple USB service reachable', 'usbmuxd on 127.0.0.1:27015');
  } catch (err) {
    bad('Apple USB service unreachable', (err as Error).message);
    note('Install the Apple Devices app (or iTunes) from the Microsoft Store.');
    note('It provides the background service that carries data over the cable.');
    process.exit(1);
  }

  // 2. Device present
  if (devices.length === 0) {
    bad('No iPhone or iPad enumerated');
    note('Connect the device by cable and unlock it. If it is plugged in and');
    note('still not listed, the Apple service may need to be restarted.');
    process.exit(1);
  }
  ok('Device enumerated', devices.map((d) => d.udid + ' via ' + d.connectionType).join(', '));

  const record = await findAttachedDevice();
  if (!record) {
    bad('No cable-attached device');
    process.exit(1);
  }

  // 3. Pairing
  try {
    const pair = await loadPairRecord(record.udid);
    ok('Pair record found', 'host ' + pair.hostId.slice(0, 12) + '…');
  } catch (err) {
    bad('Not paired with this PC', (err as Error).message);
    note('Unlock the phone and tap Trust when prompted, then run this again.');
    process.exit(1);
  }

  // 4. Lockdown session + AFC
  let session: DeviceSession;
  try {
    session = await DeviceSession.open(record);
    const { info } = session;
    ok('Trusted session established', info.name + ', ' + info.deviceClass + ', iOS ' + info.iosVersion);
    ok(
      'Storage reported',
      (info.capacityBytes / 1e9).toFixed(0) + ' GB total, ' +
        (info.freeBytes / 1e9).toFixed(0) + ' GB free',
    );
  } catch (err) {
    bad('Could not open a trusted session', (err as Error).message);
    note('Make sure the phone is unlocked; a locked device refuses file access.');
    process.exit(1);
  }

  // 5. Library listing
  const started = process.hrtime.bigint();
  const scan = await scanLibrary(session.pool);
  const listMs = Number(process.hrtime.bigint() - started) / 1e6;
  ok(
    'Camera roll listed',
    scan.assets.length.toLocaleString() + ' items in ' + scan.folders.length + ' folders, ' +
      listMs.toFixed(0) + 'ms',
  );

  // 6. Thumbnails
  const still = scan.assets.find((a) => a.kind === 'photo');
  const video = scan.assets.find((a) => a.kind === 'video' && !a.motionPart);
  await session.pool.run(async (afc: AfcClient) => {
    for (const [label, asset] of [['still', still], ['video', video]] as const) {
      if (!asset) continue;
      const roots =
        label === 'still'
          ? ['/PhotoData/Thumbnails/V2/DCIM/' + asset.id + '/5005.JPG']
          : [
              '/PhotoData/Thumbnails/VideoKeyFrames/DCIM/' + asset.id + '/5005.JPG',
              '/PhotoData/Thumbnails/V2/DCIM/' + asset.id + '/5005.JPG',
            ];
      let found = false;
      for (const path of roots) {
        try {
          const data = await afc.readFile(path, 512 * 1024);
          if (data.length > 0) {
            ok('Device thumbnail (' + label + ')', (data.length / 1024).toFixed(0) + ' KB');
            found = true;
            break;
          }
        } catch {
          /* try next layout */
        }
      }
      if (!found) bad('No device thumbnail for ' + label + ' — grid will show placeholders');
    }
  });

  // 7. Throughput
  const big = scan.assets.find((a) => a.kind === 'video' && !a.motionPart);
  if (big) {
    const info = await session.pool.run((afc) => afc.stat('/DCIM/' + big.id));
    if (info.size > 4_000_000) {
      const t = process.hrtime.bigint();
      const read = await session.pool.run((afc) =>
        afc.streamFile('/DCIM/' + big.id, () => undefined, { chunkSize: 1024 * 1024 }),
      );
      const seconds = Number(process.hrtime.bigint() - t) / 1e9;
      const rate = read / 1e6 / seconds;
      ok(
        'Read throughput',
        rate.toFixed(0) + ' MB/s on a single connection over ' +
          (record.connectionType === 'USB' ? 'USB' : 'Wi-Fi'),
      );
      if (record.connectionType !== 'USB') {
        note('Wi-Fi is far slower than the cable. Plug in for anything bulk.');
      } else if (rate < 25) {
        note('That is slow for USB 3 — try a different cable or a USB 3 port.');
      }
    }
  }

  session.close();
  console.log('\nEverything checks out.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nDiagnostics stopped: ' + (err as Error).message);
  process.exit(1);
});
