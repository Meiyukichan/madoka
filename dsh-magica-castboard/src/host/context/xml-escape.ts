/**
 * Shared XML escaping helpers for prompt/context renderers.
 *
 * @module dsh-magica-castboard/host/context/xml-escape
 */

// XML 1.0 allows tab, LF, CR, and most printable code points. These are the
// remaining C0 controls plus the two non-characters that make a parser reject
// a document outright.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

/** Escape text used as XML text content. */
export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Escape text used inside a double-quoted XML attribute. */
export function escapeXmlAttr(text: string): string {
  return escapeXml(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r\n?|\n/g, '&#10;')
}
