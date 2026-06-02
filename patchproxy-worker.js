// patch-proxy: validates PocketFM CMS auth, then forwards CMS/TTS calls
// with secret keys and CMS headers attached server-side.

const ELEVENLABS_API = 'https://api.elevenlabs.io';
const AUDIOSTACK_API = 'https://v2.api.audio';
const CMS_API = 'https://api.cms.pocketfm.com/v2/content_api';
const CMS_VERIFY_URL = 'https://api.cms.pocketfm.com/v2/content_api/book.episode_details?chapter_id=17815f5a15ba35e13c1a7500a1f7567859e4dc26&is_novel=0';
const ALLOWED_ORIGINS = [
  'https://solankigeetika-bot.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
const ALLOWED_MEDIA_HOSTS = [
  'pocketfm.com',
  'amazonaws.com',
  'cloudfront.net',
  'storage.googleapis.com',
  'googleapis.com',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check (no auth)
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('patch-proxy OK', {
        headers: { 'Content-Type': 'text/plain', ...cors },
      });
    }

    // Auth check: require valid PocketFM CMS credentials
    const accessToken = request.headers.get('x-access-token') || request.headers.get('access-token');
    const uid = request.headers.get('x-uid') || request.headers.get('uid');
    if (!accessToken || !uid) {
      return jsonError('Missing CMS auth (access-token / uid)', 401, cors);
    }

    let cmsOk;
    try {
      cmsOk = await verifyCMS(accessToken, uid);
    } catch (e) {
      return jsonError('CMS verification error: ' + e.message, 502, cors);
    }
    if (!cmsOk) {
      return jsonError('Invalid CMS auth', 403, cors);
    }

    // Route: /cms/* -> api.cms.pocketfm.com/v2/content_api/*
    if (url.pathname.startsWith('/cms/')) {
      return forwardCMS(
        request,
        CMS_API + url.pathname.replace('/cms', '') + url.search,
        accessToken,
        uid,
        cors
      );
    }

    // Route: /media-download?url=...&filename=... -> signed CMS/S3 media URL
    if (url.pathname === '/media-download') {
      return downloadMedia(url, cors);
    }

    // Route: /elevenlabs/* -> api.elevenlabs.io/*
    if (url.pathname.startsWith('/elevenlabs/')) {
      return forward(request, ELEVENLABS_API + url.pathname.replace('/elevenlabs', '') + url.search, {
        'xi-api-key': env.ELEVENLABS_KEY,
      }, cors);
    }

    // Route: /audiostack/* -> v2.api.audio/*
    if (url.pathname.startsWith('/audiostack/')) {
      return forward(request, AUDIOSTACK_API + url.pathname.replace('/audiostack', '') + url.search, {
        'x-api-key': env.AUDIOSTACK_KEY,
      }, cors);
    }

    return jsonError('Unknown route. Use /cms/..., /media-download, /elevenlabs/..., or /audiostack/...', 404, cors);
  },
};

async function verifyCMS(accessToken, uid) {
  const r = await fetch(CMS_VERIFY_URL, {
    headers: {
      'access-token': accessToken,
      'uid': uid,
      'app-client': 'consumer-web',
      'app-version': '180',
      'auth-token': 'web-auth',
      'source': 'cms',
    },
  });
  if (r.status === 401 || r.status === 403) return false;
  return true; // 200 = valid; 4xx other / 5xx = fail-open so CMS hiccups do not block TTS.
}

async function forwardCMS(request, target, accessToken, uid, cors) {
  const upstreamHeaders = new Headers();

  if (request.headers.get('Content-Type')) {
    upstreamHeaders.set('Content-Type', request.headers.get('Content-Type'));
  }
  if (request.headers.get('Accept')) {
    upstreamHeaders.set('Accept', request.headers.get('Accept'));
  }

  upstreamHeaders.set('access-token', accessToken);
  upstreamHeaders.set('uid', uid);
  upstreamHeaders.set('app-client', 'consumer-web');
  upstreamHeaders.set('app-version', '180');
  upstreamHeaders.set('auth-token', 'web-auth');
  upstreamHeaders.set('source', 'cms');

  const upstream = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
  });

  const respHeaders = new Headers(upstream.headers);
  Object.entries(cors).forEach(([k, v]) => respHeaders.set(k, v));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

async function downloadMedia(url, cors) {
  const mediaUrl = url.searchParams.get('url') || '';
  const filename = sanitizeFilename(url.searchParams.get('filename') || 'cms_audio.mp3');
  if (!mediaUrl) {
    return jsonError('Missing media url', 400, cors);
  }

  let parsed;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    return jsonError('Invalid media url', 400, cors);
  }

  if (parsed.protocol !== 'https:') {
    return jsonError('Only https media urls are allowed', 400, cors);
  }
  if (!isAllowedMediaHost(parsed.hostname)) {
    return jsonError('Media host is not allowed: ' + parsed.hostname, 403, cors);
  }

  const upstream = await fetch(parsed.toString());
  if (!upstream.ok) {
    return jsonError('Media fetch failed: HTTP ' + upstream.status, upstream.status, cors);
  }

  const respHeaders = new Headers();
  respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || guessContentType(filename));
  respHeaders.set('Content-Disposition', `attachment; filename="${filename}"`);
  respHeaders.set('Cache-Control', 'no-store');
  Object.entries(cors).forEach(([k, v]) => respHeaders.set(k, v));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function isAllowedMediaHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_MEDIA_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
}

function sanitizeFilename(name) {
  const clean = String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
  return clean || 'cms_audio.mp3';
}

function guessContentType(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'ogg') return 'audio/ogg';
  return 'audio/mpeg';
}

async function forward(request, target, extraHeaders, cors) {
  const upstreamHeaders = new Headers();

  if (request.headers.get('Content-Type')) {
    upstreamHeaders.set('Content-Type', request.headers.get('Content-Type'));
  }
  if (request.headers.get('Accept')) {
    upstreamHeaders.set('Accept', request.headers.get('Accept'));
  }

  for (const [k, v] of Object.entries(extraHeaders)) {
    upstreamHeaders.set(k, v);
  }

  const upstream = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
  });

  const respHeaders = new Headers(upstream.headers);
  Object.entries(cors).forEach(([k, v]) => respHeaders.set(k, v));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://solankigeetika-bot.github.io';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Accept,access-token,uid,x-access-token,x-uid',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonError(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
