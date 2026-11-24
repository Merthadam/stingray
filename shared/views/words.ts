/** "send_reset_email" / "sendResetEmail" / "HTTPServer" -> "send reset email" / "send reset email" / "http server". */
export const splitWords = (name: string) => name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[_\s$]+/).filter(Boolean).map(w => w.toLowerCase()).join(' ');
