import { TextDecoder } from "node:util";

/**
 * Picks the encoding of a text import by its content: strict UTF-8 when every byte sequence is valid UTF-8,
 * Windows-1252 otherwise. CSV and OFX share this rule so the two formats cannot drift apart again.
 *
 * Why the content and not a declaration: issuers keep legacy OFX headers (`CHARSET:1252`) on files whose
 * bytes are UTF-8 (DEV-125). Trusting the header decoded each accented UTF-8 pair as two characters, so
 * "Crédito" was stored as "CrÃ©dito", permanently.
 *
 * Not infallible, and the order matters: every UTF-8 text decodes as Windows-1252 without error, so the
 * strict UTF-8 attempt has to come first. The other way round fails rarely in practice: accented Latin text
 * in Windows-1252 produces byte pairs that strict UTF-8 rejects, which is what makes the fallback reliable.
 */
export function detectUtf8OrWindows1252(content: Buffer): "utf-8" | "windows-1252" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}
