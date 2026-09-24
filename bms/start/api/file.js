import { get } from '@vercel/blob';
import { makeFile } from '../lib/routes.js';

export default { fetch: makeFile({ get }) };
