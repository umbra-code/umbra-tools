// sharp, configured for this app. Tools import it from here instead of from 'sharp'.
import sharp from 'sharp';

// libvips caches open input files, which on Windows keeps them locked and stops the job's
// temp folder from being deleted. Each image is read once anyway, so the cache only gets in the way.
sharp.cache({ files: 0 });

export default sharp;
