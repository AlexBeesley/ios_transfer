# iOS Transfer — copy iPhone photos and videos to Windows (free)

<p align="left">
  <img src="icons/icon128.png" width="128" height="128" alt="iOS Transfer — photo grid icon">
</p>

**Free, open-source Windows app** to transfer photos and videos from an iPhone or iPad over USB 3. Fast grid, real thumbnails, HEIC / Live Photos / RAW, full-resolution copies. No subscription.

If you have been paying **iMazing**, using **Apple Devices / iTunes**, or waiting on Windows Explorer’s slow MTP “Apple iPhone” drive — this is the media-transfer piece of that job, without the licence.

> This is **not** a full iPhone manager. It does not back up apps, messages, or the whole device. It copies the camera roll onto your PC, quickly.

## Why people look for this

Typical searches this project is for:

- transfer iPhone photos to Windows PC without iTunes
- copy iPhone videos to computer USB 3
- iMazing alternative Windows (photos / videos only)
- import HEIC Live Photos to PC
- iPhone to PC file transfer faster than Explorer

Windows talks to an iPhone as **MTP** by default. MTP is fine for a handful of files and painful at tens of thousands. This app uses the same **usbmux / lockdown / AFC** stack Apple’s own tools use, over the USB multiplexer that ships with the Apple Devices app — so listing, thumbnails, and copies stay fast on a large camera roll.

## Features

- Browse the camera roll in a grid (tested around **35,000 items**)
- Thumbnails from the phone’s own thumbnail store (no HEIC decode for the grid)
- Video duration badges from the movie header (not a full download)
- Filters: photos, videos, Live Photos, RAW, screenshots, length, date, size
- Copy at USB 3 speed with progress, honest throughput, and ETA
- Live Photos: still + motion `.MOV` stay together
- Windows **Date created** set to the capture time (Explorer sorts correctly)
- Flat copy or `YYYY\YYYY-MM` folders
- Resume: already-copied files are skipped
- “Keep both” when iPhone names wrap past `IMG_9999`
- Warns if the destination disk is too small
- Optional delete from the phone, behind a typed confirmation

## iMazing, iTunes, and Explorer

| | iOS Transfer | iMazing | Apple Devices / iTunes | File Explorer (MTP) |
|---|---|---|---|---|
| Price | Free, open source | Paid licence | Free | Built in |
| Copy photos / videos to PC | Yes | Yes | Yes, slower UX | Yes, slow on big libraries |
| Full device backup, apps, SMS | No | Yes | Partial | No |
| Fast USB 3 grid + thumbnails | Yes | Yes | No | No |
| HEIC / Live Photo aware | Yes | Yes | Mixed | Mixed |

Use this if you want **files on a disk**. Keep paying iMazing if you need backups, app data, or a full device manager.

## Requirements

- **Windows 10 or 11**
- **[Apple Devices](https://apps.microsoft.com/detail/9np83lwlpz9k)** (Microsoft Store) or iTunes — provides `AppleMobileDeviceProcess` on `127.0.0.1:27015`
- iPhone or iPad **trusted** with this PC (“Trust This Computer”) and unlocked
- USB cable (USB 3 is much faster than Wi-Fi pairing)

```bash
npm run doctor
```

tells you exactly what is missing.

## Install and run

```bash
git clone https://github.com/AlexBeesley/ios_transfer.git
cd ios_transfer
npm install
npm start
```

Standalone Windows build (no Node required to run):

```bash
npm run package
```

That writes `release\iOS Transfer-win32-x64\iOS Transfer.exe`. Pin it to the taskbar after the first launch.

Other scripts:

```bash
npm run dev        # rebuild on change
npm run typecheck
npm run doctor     # USB / pairing diagnostics
npm run e2e        # real device check (copies several GB; E2E_QUICK=1 for a small copy)
npm run uitest     # UI on synthetic data, no phone
npm run icon
npm run package
```

## How it works

```
renderer (React)
   │  IPC + thumb:// protocol
main process
   ├── usbmux    TCP 127.0.0.1:27015 — enumerate devices, open device ports
   ├── lockdown  device port 62078 — TLS from the host pair record, StartService
   └── AFC       Apple File Conduit — /DCIM and /PhotoData
```

Code lives in `src/main/device/` (`plist.ts`, `usbmux.ts`, `lockdown.ts`, `afc.ts`, `session.ts`).

### Why it is fast

AFC allows **one outstanding request per connection**, so speed comes from a pool. Measured on an iPhone 17 Pro (iOS 26.1, ~35k items, 845 GB) over USB 3:

| Operation | Result |
| --- | --- |
| Trusted session | 44 ms |
| List 46 folders / 35,206 items | 137 ms |
| File metadata (size + date) | ~4,400 files/s |
| Thumbnails | ~780–1,230/s, ~50 KB each |
| Bulk copy | 72 MB/s sustained, 181 MB/s peak |

**Thumbnails are never decoded.** iOS already stores a ~360×480 JPEG at `/PhotoData/Thumbnails/V2/DCIM/<folder>/<file>/5005.JPG`. Videos use a parallel `VideoKeyFrames` tree.

**Video duration** is three small AFC reads of the QuickTime `moov` atom (~400 clips/s), cached, only for tiles on screen.

**Capture dates** are stamped as Windows creation time via PowerShell in batches (`filetimes.ts`), so Explorer does not show “imported today” for everything.

**Write concurrency follows the disk.** One stream on HDD, six on SSD. Throughput is measured from **completed files**, not write-cache absorption, so the ETA is honest.

**The grid paints from the listing first**; sizes and dates stream in behind it. Metadata never starves thumbnail connections.

## Limits

- Only media **physically on the device**. iCloud-only originals (“Optimize iPhone Storage”) cannot be copied until they are downloaded to the phone.
- No albums, favourites, or Moments (that data is in a multi-GB `Photos.sqlite`).
- One-way: iPhone → PC.
- `.AAE` edit sidecars are hidden.
- Wi-Fi pairing works but is ~40× slower than USB; use a cable.

## License

MIT. Not affiliated with Apple or DigiDNA / iMazing.
