import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import type { Request, Response } from 'express';

const FIELDS = ['nodes', 'edges', 'transactions'];

/** Streams multipart bodies to server-owned paths; Python validates Parquet content. */
export async function receiveUpload(
  request: Request, response: Response, inputDir: string, maxBytes: number, signal: AbortSignal,
): Promise<void> {
  if (!request.is('multipart/form-data')) throw new Error('Expected multipart/form-data.');
  const writes: Promise<void>[] = [];
  const storage: multer.StorageEngine = {
    _handleFile(_req, file, callback) {
      const filename = `${file.fieldname}.parquet`;
      const path = join(inputDir, filename);
      const output = createWriteStream(path, { flags: 'wx' });
      const writing = pipeline(file.stream, output, { signal }).then(
        () => { callback(null, { destination: inputDir, filename, path, size: output.bytesWritten }); },
        (error: Error) => { callback(error); },
      );
      writes.push(writing);
    },
    _removeFile(_req, file, callback) {
      void rm(file.path, { force: true }).then(() => callback(null), callback);
    },
  };
  const parser = multer({ storage, limits: { fileSize: maxBytes, files: 3, fields: 0, parts: 3 } })
    .fields(FIELDS.map((name) => ({ name, maxCount: 1 })));
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Upload interrupted or timed out.'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => parser(request, response, (error: unknown) => error ? reject(error) : resolve())),
      interrupted,
    ]);
    const files = request.files as Record<string, Express.Multer.File[]> | undefined;
    if (!files || FIELDS.some((name) => files[name]?.length !== 1 || files[name][0].size === 0)) {
      throw new Error('Expected one nonempty file in each of nodes, edges, transactions.');
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) { request.unpipe(); request.resume(); }
    await Promise.allSettled(writes);
  }
}
