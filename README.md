# iOS Transfer

A Windows desktop app for pulling photos and videos off an iPhone over USB 3 —
fast browsing, fast thumbnails, fast copies.

Built as an Electron app with a hand-written implementation of Apple's USB
stack, so there are no native modules to compile and no vendor SDK to ship.

## What it does

- Lists the whole camera roll in well under a second, even at 35,000 items
- Shows real thumbnails pulled from the device's own thumbnail store
- Displays running time on video tiles, read from each movie's header
- Groups by capture date, with filters for photos, videos, Live Photos and RAW
- Copies at full USB 3 speed with progress, throughput and ETA
- Filter by file type, date range and file size; sort by date, size or name
- Shows how much the current filter adds up to, so you can copy a subset
- Live transfer state: current files, streams, honest throughput and ETA
- Sets Windows' "Date created" to the capture time, so Explorer sorts correctly
- Double-click any item to open the original in your default viewer
- One click to drop videos under 30 seconds from a selection
- Find stray clips: filter videos by length (1s / 2s / 5s presets, or any value)
- Right-click for Properties; keyboard navigation throughout the grid
- Warns before a copy that will not fit on the destination drive
- Delete from the iPhone, behind a typed confirmation
- Resumable — re-running a copy steps over what already arrived
- Remembers your destination and copy options between runs
- Flat copy by default, or sorted into `YYYY\YYYY-MM` folders; preserves capture dates
- Understands Live Photos: the paired `.MOV` is hidden in the grid and copied
  alongside the still

## Requirements

- Windows 10/11
- **Apple Devices** app (or iTunes) installed — it provides the background
  service (`AppleMobileDeviceProcess`, listening on `127.0.0.1:27015`) that
  carries data over the cable. Without it nothing on the PC can see the phone.
- The iPhone paired with this PC ("Trust This Computer") and unlocked

Run `npm run doctor` to check all of this and get told exactly what is missing.

## Getting started

```bash
npm install
npm start
```

Build a standalone Windows app (no Node needed to run it):

```bash
npm run package
```

That produces `release\iOS Transfer-win32-x64\iOS Transfer.exe`, with a
generated icon. Run it once, then right-click its taskbar button and choose
"Pin to taskbar".

Other scripts:

```bash
npm run dev        # rebuild on change
npm run typecheck  # tsc --noEmit
npm run doctor     # diagnose the connection, step by step
npm run e2e        # full check against an attached device, incl. a real copy
npm run uitest     # run the UI on synthetic data, no device needed
npm run icon       # regenerate build/icon.ico
npm run package    # build a standalone .exe in release/
```

`npm run e2e` copies several GB to verify throughput; set `E2E_QUICK=1` to check
the logic without saturating a disk.

## How it works

Windows exposes an iPhone over MTP, but MTP is slow and gives a poor view of the
library. This app instead speaks the same protocols Apple's own tools use, over
the USB multiplexer that ships with Apple Devices:

```
renderer (React)
   │  IPC + thumb:// protocol
main process
   │
   ├── usbmux    TCP 127.0.0.1:27015 — enumerate devices, open device ports
   ├── lockdown  device port 62078 — TLS session from the host pair record,
   │             then StartService
   └── AFC       Apple File Conduit — the media partition (/DCIM, /PhotoData)
```

`src/main/device/` holds that stack: `plist.ts` (XML + binary property lists),
`usbmux.ts`, `lockdown.ts`, `afc.ts`, and `session.ts` which owns the connection
pool.

### Why it is fast

AFC allows **one outstanding request per connection**, so throughput comes
entirely from running a pool of them. Measured on an iPhone 17 Pro (iOS 26.1,
35,449 items, 845 GB) over USB 3:

| Operation | Result |
| --- | --- |
| Trusted session established | 44 ms |
| List 46 folders / 35,206 items | 137 ms |
| File metadata (size + date) | ~4,400 files/s |
| Thumbnails | ~780–1,230/s, ~50 KB each |
| Bulk copy | 72 MB/s sustained, 181 MB/s peak |

Three decisions do most of the work:

**Thumbnails are never decoded.** iOS already stores a ~360×480 JPEG next to
every still at `/PhotoData/Thumbnails/V2/DCIM/<folder>/<file>/5005.JPG`. The app
reads those directly, so it never touches a multi-megabyte HEIC and never needs
an HEIC decoder. Videos have no entry there — their key frames live under a
parallel `VideoKeyFrames` tree, which the app probes once and then remembers.

**Video durations cost three small reads.** Running time is not in the
filesystem metadata, so it comes from the QuickTime movie header. Rather than
pull the file down, the app walks the top-level atom chain with AFC seeks:
iPhone recordings lay out `ftyp`, then a multi-megabyte `mdat`, then `moov` at
the end, so the media data is skipped entirely and only the header is read
(~400 clips/s). Results are cached in memory and on disk, and only the videos
actually on screen are ever asked for.

**Capture dates survive the copy.** Node can set access and modified times but
not Windows' creation time, which is the column Explorer sorts by — so imported
photos would otherwise all look created at import time. `filetimes.ts` batches
the work out to PowerShell, one process per 400 files rather than per file.

**Write concurrency follows the destination.** Reads want many parallel AFC
connections; writes do not. Six concurrent streams onto a hard disk turn one
sequential write into constant head seeking — measured on a Seagate ST2000DM008
(a shingled drive), that gave 48 MB/s at a ~5 second average response time while
the phone sat idle. The destination's media type is detected once per drive and
the copy uses 1 stream on a hard disk, 6 on an SSD.

**Throughput is measured from files that landed.** Counting bytes as they are
handed to the OS reports whatever the write cache will absorb — on a slow disk
that read four times faster than the disk was actually writing, and the ETA was
out by hours. The figure now comes from completed files over a 30-second window.

**The grid appears before the metadata does.** Listing is ~40× faster than
stat-ing every file, so the UI renders immediately from the listing (ordered by
DCIM numbering, which is already chronological) while sizes and capture dates
stream in behind it and re-sort the view.

**Foreground work is protected.** The metadata sweep is capped below the pool
size so thumbnails for the visible grid always find a free connection. Without
that reservation the sweep holds every lane and the grid stays blank until it
finishes.

Thumbnails reach the renderer through a custom `thumb://` protocol rather than
IPC, so image bytes are never serialized, and they are cached in memory (96 MB
budget, LRU) and on disk under the app's user-data directory.

## Notes and limits

- Only assets physically on the device are listed. Items that live only in
  iCloud ("Optimize iPhone Storage") have no original to copy.
- Albums, favourites and moments are not shown. That metadata lives in
  `PhotoData/Photos.sqlite`, which was 2.9 GB on the test device — too large to
  copy off just to draw a sidebar. The date grouping comes from file timestamps.
- Copying is one-way, device → PC.
- `.AAE` edit sidecars are excluded from the grid.
- iPhone file names repeat: the camera counter wraps past `IMG_9999` and starts
  again in a new DCIM folder. On the test device 9,692 names were used more than
  once, so a flat copy of the whole library would put 11,915 files in conflict.
  The default is therefore "Keep both", and the copy dialog warns when the
  current selection contains repeats. Destination naming is serialized across
  transfer lanes so two files with the same name can never race for one path.
- Windows keeps closed sockets in `TIME_WAIT` for two minutes and only has
  ~16k ephemeral ports. Other iOS software polling the same service can exhaust
  them, so the app pools its connections and retries `EADDRINUSE` with backoff.
