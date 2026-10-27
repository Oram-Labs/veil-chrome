// Which requests on each site may carry chat text, or bring it back. Only
// these go to Veil, which makes the final call (see PROTOCOL.md).
// Everything else on the page is left alone, so the site stays fast.

import type { Site } from './protocol';

export function interesting(site: Site, method: string, path: string): boolean {
  const p = path.split('?')[0];
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return false;
  if (site === 'claude.ai') {
    return (
      p.endsWith('/PerformAction') ||
      p.endsWith('/StreamTimeline') ||
      p.endsWith('/generate_title_and_branch') ||
      p.includes('/chat_conversations') ||
      p.includes('/v1/code/sessions')
    );
  }
  return (
    p === '/backend-api/conversations' ||
    p.startsWith('/backend-api/conversation') ||
    p.startsWith('/backend-api/f/conversation')
  );
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
