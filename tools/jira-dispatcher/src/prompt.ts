import { readFileSync } from "node:fs";

/** Renders `{{name}}` placeholders. Unknown placeholders are an error so templates cannot silently drift. */
export function renderTemplate(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`Placeholder desconhecido no template: {{${name}}}`);
    const value = values[name];
    return value === undefined || value === "" ? "(não informado)" : String(value);
  });
}

export function renderTemplateFile(path: string, values: Record<string, string | number | undefined>): string {
  return renderTemplate(readFileSync(path, "utf8"), values);
}
