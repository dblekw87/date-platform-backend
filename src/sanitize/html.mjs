/**
 * Allowlist HTML sanitizer for user-authored rich text.
 *
 * The input comes from a contenteditable editor, so it can contain anything a
 * user pasted from another page. Rather than stripping bad patterns out of the
 * original string, this parses the input and re-serializes it from scratch:
 * text is escaped, and only known tags and attributes are re-emitted. Anything
 * unrecognized is dropped by construction, so a missed attack pattern cannot
 * survive into the output.
 */

const allowedTags = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "hr", "i", "img", "li", "ol", "p", "pre", "s",
  "span", "strong", "u", "ul"
]);

// Any attribute not listed here is dropped, which covers every on* handler.
const allowedAttributes = new Map([
  ["a", new Set(["href"])],
  ["code", new Set(["class"])],
  ["div", new Set(["class"])],
  ["figure", new Set(["class", "data-image-block"])],
  ["img", new Set(["alt", "src"])],
  ["p", new Set(["class"])],
  ["pre", new Set(["class"])],
  ["span", new Set(["class"])]
]);

const voidTags = new Set(["br", "hr", "img"]);

// These carry executable or parser-confusing content, so their children go too.
// svg/math switch the parser into foreign content, a classic mutation-XSS route.
const dropSubtreeTags = new Set([
  "base", "button", "embed", "form", "head", "iframe", "input", "link", "math",
  "meta", "noscript", "object", "script", "select", "style", "svg", "template",
  "textarea", "title"
]);

const maxInputLength = 200_000;

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

// Allowlist rather than blocklist: anything that is not recognizably a safe URL
// is dropped, so javascript:, vbscript:, and protocol-relative URLs never pass.
function safeHref(value) {
  const url = String(value ?? "").trim();

  if (/^https?:\/\/[^\s<>"']+$/i.test(url)) return url;
  if (/^mailto:[^\s<>"']+$/i.test(url)) return url;
  if (/^\/[^/\\]/.test(url)) return url;
  if (/^#[\w-]*$/.test(url)) return url;

  return null;
}

function safeSrc(value) {
  const url = String(value ?? "").trim();

  if (/^https?:\/\/[^\s<>"']+$/i.test(url)) return url;
  if (/^\/[^/\\]/.test(url)) return url;
  // Inline previews only. svg+xml stays out because it can carry script.
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(url)) return url;

  return null;
}

function safeClass(value) {
  const className = String(value ?? "").trim().replace(/[^\w\s-]/g, "").slice(0, 200).trim();

  return className || null;
}

function attributeValue(tagName, attributeName, rawValue) {
  if (attributeName === "href") return safeHref(rawValue);
  if (attributeName === "src") return safeSrc(rawValue);
  if (attributeName === "class") return safeClass(rawValue);
  if (attributeName === "alt") return String(rawValue ?? "").slice(0, 300);
  if (attributeName === "data-image-block") return rawValue === "true" ? "true" : null;

  return null;
}

/** Finds the index of the `>` that ends a tag, skipping quoted attribute values. */
function findTagEnd(html, start) {
  let quote = null;

  for (let index = start; index < html.length; index += 1) {
    const character = html[index];

    if (quote) {
      if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === ">") return index;
  }

  return -1;
}

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match = pattern.exec(source);

  while (match) {
    const name = match[1].toLowerCase();

    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }

    match = pattern.exec(source);
  }

  return attributes;
}

function serializeOpenTag(tagName, attributeSource) {
  const allowed = allowedAttributes.get(tagName);
  const parts = [tagName];

  if (allowed && attributeSource.trim()) {
    parseAttributes(attributeSource).forEach((rawValue, name) => {
      if (!allowed.has(name)) return;

      const value = attributeValue(tagName, name, rawValue);

      if (value === null) return;

      parts.push(`${name}="${escapeAttribute(value)}"`);
    });
  }

  if (voidTags.has(tagName)) return `<${parts.join(" ")} />`;

  return `<${parts.join(" ")}>`;
}

export function sanitizeHtml(input) {
  if (typeof input !== "string" || !input) return "";

  const html = input.slice(0, maxInputLength);
  const output = [];
  const openTags = [];
  let skipUntilTag = null;
  let skipDepth = 0;
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);

    if (tagStart === -1) {
      if (!skipUntilTag) output.push(escapeText(html.slice(index)));
      break;
    }

    if (tagStart > index && !skipUntilTag) {
      output.push(escapeText(html.slice(index, tagStart)));
    }

    // Comments, doctypes, and processing instructions carry no content we keep.
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);

      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    if (html.startsWith("<!", tagStart) || html.startsWith("<?", tagStart)) {
      const declarationEnd = html.indexOf(">", tagStart);

      index = declarationEnd === -1 ? html.length : declarationEnd + 1;
      continue;
    }

    // A "<" that cannot begin a tag is literal text, as in "5 < 10".
    if (!/^<\/?[a-zA-Z]/.test(html.slice(tagStart, tagStart + 3))) {
      if (!skipUntilTag) output.push("&lt;");
      index = tagStart + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart + 1);

    if (tagEnd === -1) {
      // An unterminated tag: drop the remainder rather than emitting raw markup.
      break;
    }

    const rawTag = html.slice(tagStart + 1, tagEnd);
    const isClosing = rawTag.startsWith("/");
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag);

    index = tagEnd + 1;

    if (!nameMatch) continue;

    const tagName = nameMatch[1].toLowerCase();

    if (skipUntilTag) {
      if (tagName !== skipUntilTag) continue;

      if (isClosing) {
        skipDepth -= 1;
        if (skipDepth <= 0) {
          skipUntilTag = null;
          skipDepth = 0;
        }
      } else if (!rawTag.endsWith("/")) {
        skipDepth += 1;
      }

      continue;
    }

    if (dropSubtreeTags.has(tagName)) {
      if (!isClosing && !rawTag.endsWith("/")) {
        skipUntilTag = tagName;
        skipDepth = 1;
      }

      continue;
    }

    // Unknown-but-harmless tags are unwrapped: the tag goes, the text stays.
    if (!allowedTags.has(tagName)) continue;

    if (isClosing) {
      const openIndex = openTags.lastIndexOf(tagName);

      if (openIndex === -1) continue;

      // Close anything left open inside it so the output stays balanced.
      while (openTags.length > openIndex) {
        output.push(`</${openTags.pop()}>`);
      }

      continue;
    }

    const attributeSource = rawTag.slice(nameMatch[0].length).replace(/\/\s*$/, "");

    output.push(serializeOpenTag(tagName, attributeSource));

    if (!voidTags.has(tagName) && !rawTag.endsWith("/")) {
      openTags.push(tagName);
    }
  }

  while (openTags.length) {
    output.push(`</${openTags.pop()}>`);
  }

  return output.join("");
}
