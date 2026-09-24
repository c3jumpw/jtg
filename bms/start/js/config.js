/* ============================================================
   Brand Discovery — CONFIG
   Front-end settings only. Nothing secret belongs here: the
   Resend key and storage token live in Vercel environment variables.
   ============================================================ */
window.F5_CONFIG = {
  company: 'Build My Startup',

  // Where the "Book a call" button on the thank-you screen goes.
  // Placeholder booking link. Points at the main site until the booking page is live.
  bookingUrl: 'https://buildmystart-up.com/#book',

  // The backend routes (Vercel functions in /api). On hosts that don't have
  // them (GitHub Pages, a local file) the form runs in preview mode.
  endpoints: {
    submit: 'api/submit',
    upload: 'api/upload'
  },
  blobClient: 'js/vendor/blob-client.js',

  // Upload limits (the server enforces the same values).
  maxFilesPerGroup: 10,
  maxFileMB: 25,
  allowedExt: [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'tif', 'tiff',
    'pdf', 'ai', 'eps', 'psd', 'indd', 'fig', 'sketch',
    'doc', 'docx', 'ppt', 'pptx', 'key', 'pages', 'xls', 'xlsx', 'csv', 'txt', 'rtf',
    'zip', 'mp4', 'mov', 'mp3', 'wav', 'otf', 'ttf', 'woff', 'woff2'
  ]
};
