// Emit templates: "@name" is the text of capture `name`, "@@" a literal "@". Capture names in templates are identifiers.
const TOKEN = /@@|@([A-Za-z_][A-Za-z0-9_]*)/g;

/** Capture names a template references. */
export function templateCaptures(template: string): string[] {
  return [...template.matchAll(TOKEN)].flatMap(m => m[1] ? [m[1]] : []);
}

/** Render with one value per capture; null when a referenced capture has no value. */
export function renderTemplate(template: string, values: ReadonlyMap<string, string>): string | null {
  let missing = false;
  const text = template.replace(TOKEN, (token, name: string | undefined) => {
    if (!name) return '@';
    const value = values.get(name);
    if (value === undefined) missing = true;
    return value ?? '';
  });
  return missing ? null : text;
}
