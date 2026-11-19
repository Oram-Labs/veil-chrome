// Which requests on each site may carry chat text, or bring it back. Only
// these go to Veil, which makes the final call (see PROTOCOL.md).
// Everything else on the page is left alone, so the site stays fast.

import type { Site } from './protocol';

/** Where Gemini sends its chats: Google WebChannel, POSTs up and a long-polling GET down. */
export const GEMINI_CHAT_HOST = 'geminiweb-pa.clients6.google.com';

/** True for Gemini's chat address. */
export function isGeminiChat(url: URL): boolean {
  return url.protocol === 'https:' && url.host === GEMINI_CHAT_HOST && url.pathname === '/v1/processSession';
}

/**
 * The hosts a site's chat requests may go to besides its own: Gemini's go
 * to another one.
 */
export function chatHost(site: Site, host: string, pageHost: string): boolean {
  return host === pageHost || (site === 'gemini.google.com' && host === GEMINI_CHAT_HOST);
}

export function interesting(site: Site, method: string, path: string, host?: string): boolean {
  const p = path.split('?')[0];
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return false;
  if (site === 'gemini.google.com') {
    return host === GEMINI_CHAT_HOST && p === '/v1/processSession' && (m === 'GET' || m === 'POST');
  }
  if (site === 'claude.ai') {
    return (
      p.endsWith('/PerformAction') ||
      p.endsWith('/StreamTimeline') ||
      p.endsWith('/generate_title_and_branch') ||
      p.includes('/chat_conversations') ||
      p.includes('/v1/code/sessions')
    );
  }
  // A visitor who is not logged in is served from /backend-anon, with the
  // same routes as the signed-in /backend-api.
  const api = p.startsWith('/backend-api/') ? p.slice('/backend-api'.length) : p.startsWith('/backend-anon/') ? p.slice('/backend-anon'.length) : '';
  return api === '/conversations' || api.startsWith('/conversation') || api.startsWith('/f/conversation');
}

/**
 * True when the request may send text to the site, rather than read. Only
 * these are blocked when Veil can't be reached.
 */
export function sends(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET') return false;
  // claude.ai loads a chat's timeline with a POST that carries no text.
  return !path.split('?')[0].endsWith('/StreamTimeline');
}
