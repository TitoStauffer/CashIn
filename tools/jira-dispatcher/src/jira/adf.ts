/** Minimal helpers for Atlassian Document Format (ADF), used by Jira Cloud REST v3. */

export interface AdfDocument {
  type: "doc";
  version: 1;
  content: unknown[];
}

export function textToAdf(text: string): AdfDocument {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n{2,}/).map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph }]
    }))
  };
}

/** Extracts plain text from an ADF node (or returns strings unchanged). */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (typeof node !== "object") return String(node);
  const value = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  if (value.type === "text") return value.text ?? "";
  if (value.type === "hardBreak") return "\n";
  if (value.type === "mention" || value.type === "emoji" || value.type === "status") {
    return String(value.attrs?.text ?? value.attrs?.shortName ?? "");
  }
  const inner = adfToText(value.content ?? []);
  const blockTypes = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "panel", "tableRow", "rule"]);
  return value.type && blockTypes.has(value.type) ? `${inner}\n` : inner;
}

/**
 * Converts a Jira field value into the textual values it represents.
 * Handles plain strings, numbers, ADF documents, option objects ({ value }), named objects ({ name }) and arrays.
 */
export function fieldValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "doc") {
      const text = adfToText(obj).trim();
      return text === "" ? [] : [text];
    }
    for (const key of ["value", "name", "displayName", "key"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).trim() !== "") {
        const nested = obj.child ? fieldValues(obj.child) : [];
        return [obj[key] as string, ...nested];
      }
    }
  }
  return [];
}
