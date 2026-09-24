import { head } from '@vercel/blob';
import { makeSubmit } from '../lib/routes.js';

export default { fetch: makeSubmit({ head }) };
