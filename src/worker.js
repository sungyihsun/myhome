import html from '../public/index.html';
import { onRequest as day } from '../functions/api/day/[date].js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/day\/([^/]+)$/);
    if (m) return day({ request, env, params: { date: m[1] } });
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    return new Response('Not found', { status: 404 });
  },
};
