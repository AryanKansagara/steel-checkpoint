// Vercel serves the UI and forwards API requests to the persistent Docker service.
const raw = process.env.BACKEND_ORIGIN;
let backend;
try { backend = new URL(raw ?? ''); } catch { throw new Error('Set BACKEND_ORIGIN to the deployed HTTPS backend origin before building.'); }
if (backend.protocol !== 'https:' || backend.origin !== raw || backend.username || backend.password || backend.hostname.includes('*')) {
  throw new Error('BACKEND_ORIGIN must be a canonical HTTPS origin without credentials, path, query or fragment.');
}
export const config = {
  framework: null,
  installCommand: '',
  buildCommand: 'node scripts/build-frontend.mjs',
  outputDirectory: 'dist',
  rewrites: [
    { source: '/api/:path*', destination: backend.origin + '/api/:path*' },
    { source: '/healthz', destination: backend.origin + '/healthz' },
    { source: '/readyz', destination: backend.origin + '/readyz' },
  ],
  headers: [{ source: '/(.*)', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Cache-Control', value: 'no-store' },
    { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" },
  ] }],
};
