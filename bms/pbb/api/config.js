// Vercel Serverless Function
// Serves Resend config securely from environment variables
// brand-quiz.html fetches /api/config on load

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://pbb.buildmystart-up.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.status(200).json({
    k: process.env.RESEND_KEY   || '',
    f: process.env.FROM_DOMAIN  || 'onboarding@buildmystart-up.com',
    a: process.env.ADMIN_EMAIL  || 'support@buildmystart-up.com'
  });
}
