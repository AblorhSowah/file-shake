/** Escapes text for use in HTML text or double-quoted attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 16 random bytes -> 32 hex characters. */
export function makeNonce(randomBytes: (n: number) => Uint8Array): string {
  let out = '';
  for (const b of randomBytes(16)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The webview document: strict CSP (nonce'd script only), no inline script/style/handlers, no remote URLs. */
export function buildWebviewHtml(p: {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  title: string;
}): string {
  const csp = `default-src 'none'; style-src ${escapeHtml(p.cspSource)}; script-src 'nonce-${escapeHtml(p.nonce)}'; img-src ${escapeHtml(p.cspSource)} data:; font-src ${escapeHtml(p.cspSource)};`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${escapeHtml(p.title)}</title>`,
    `<link rel="stylesheet" href="${escapeHtml(p.styleUri)}">`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script nonce="${escapeHtml(p.nonce)}" src="${escapeHtml(p.scriptUri)}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
