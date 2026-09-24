import { handleUpload } from '@vercel/blob/client';
import { makeUpload } from '../lib/routes.js';

export default { fetch: makeUpload({ handleUpload }) };
