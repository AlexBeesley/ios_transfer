/** Runs in the benchmark window: loads CLIP and times image + text encoding. */
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  type Processor,
} from '@xenova/transformers';

declare global {
  interface Window {
    bench: { thumbs: (count: number) => Promise<ArrayBuffer[]> };
  }
}

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'model://m/';
env.backends.onnx.wasm.wasmPaths = 'model://ort/';

async function main(): Promise<void> {
  console.log('threads available: ' + (typeof SharedArrayBuffer !== 'undefined'));
  console.log('hardwareConcurrency: ' + navigator.hardwareConcurrency);

  let t = performance.now();
  const processor = (await AutoProcessor.from_pretrained(MODEL_ID)) as Processor;
  const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });
  console.log('vision model loaded in ' + (performance.now() - t).toFixed(0) + 'ms');

  const buffers = await window.bench.thumbs(60);
  console.log('got ' + buffers.length + ' thumbnails');
  if (buffers.length === 0) {
    console.log('BENCH DONE (no thumbnails cached)');
    return;
  }

  // Warm up: the first inference pays one-off allocation costs.
  const first = await RawImage.fromBlob(new Blob([buffers[0]]));
  await vision({ ...(await processor(first)) });

  t = performance.now();
  let encoded = 0;
  for (const buffer of buffers) {
    const image = await RawImage.fromBlob(new Blob([buffer]));
    const inputs = await processor(image);
    const out = await vision({ ...inputs });
    if (out.image_embeds.dims[1] !== 512) throw new Error('unexpected embedding size');
    encoded++;
  }
  const elapsed = performance.now() - t;
  console.log(
    'encoded ' + encoded + ' images in ' + (elapsed / 1000).toFixed(1) + 's = ' +
      (elapsed / encoded).toFixed(0) + 'ms each = ' + (encoded / (elapsed / 1000)).toFixed(1) + '/s',
  );
  console.log(
    'projected for 20,765 thumbnails: ' +
      (((elapsed / encoded) * 20765) / 60000).toFixed(1) + ' minutes',
  );

  t = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const text = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });
  const tokens = tokenizer(['a photo of a sunny beach'], { padding: true, truncation: true });
  const embeds = await text({ ...tokens });
  console.log(
    'text model loaded + query encoded in ' + (performance.now() - t).toFixed(0) + 'ms, dims ' +
      embeds.text_embeds.dims.join('x'),
  );

  console.log('BENCH DONE');
}

main().catch((err) => {
  console.log('BENCH FAILED: ' + (err as Error).message);
  console.log('BENCH DONE');
});
