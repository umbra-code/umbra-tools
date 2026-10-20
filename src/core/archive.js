// Zip archives for jobs that produce several files.
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';

/**
 * Writes `files` into a zip at `target`, each under its own name. Files are stored without
 * compression: media formats are already compressed, so deflating them only costs time.
 */
export function zipFiles(files, target) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const file of files) zip.addFile(file, path.basename(file), { compress: false });
    zip.end();
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(fs.createWriteStream(target)).on('finish', resolve).on('error', reject);
  });
}
