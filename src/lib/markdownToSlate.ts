/**
 * Converts a Markdown string to the Slate node format used by the DeXe
 * investing-dashboard frontend.
 *
 * Uses `unified` + `remark-parse` + `remark-slate-transformer` with overrides
 * that map remark's default node types to the frontend's ELEMENT_TYPES enum:
 *
 *   Remark default       → Frontend Slate type
 *   ─────────────────────────────────────────────
 *   heading depth=1      → "heading-one"
 *   heading depth=2      → "heading-two"
 *   heading depth=3      → "heading-three"
 *   paragraph            → "paragraph"           (same)
 *   list ordered=false    → "bulleted-list"
 *   list ordered=true     → "numbered-list"
 *   listItem             → "list-item"
 *   code                 → "code-block"
 *   link                 → "link"
 *   image                → "image"
 *   delete               → "strikethrough"        (~~text~~)
 *
 *   Text marks:
 *   strong               → { bold: true }
 *   emphasis             → { italic: true }
 *   inlineCode           → wrapped in code-inline element
 *   delete               → { strikethrough: true }
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkToSlate } from "remark-slate-transformer";

/* eslint-disable @typescript-eslint/no-explicit-any */
type SlateNode = Record<string, unknown>;
type Next = (children: any[]) => any[];

/**
 * Override builders that remap remark-slate-transformer's default output
 * into the exact element/mark types the frontend expects.
 */
const overrides: Record<string, (node: any, next: Next) => SlateNode | SlateNode[] | undefined> = {
  // ── Block elements ──────────────────────────────────────────────
  heading(node, next) {
    const depthMap: Record<number, string> = {
      1: "heading-one",
      2: "heading-two",
      3: "heading-three",
    };
    return {
      type: depthMap[node.depth as number] ?? "heading-three",
      children: next(node.children),
    };
  },

  // paragraph — default type name matches, but we define it explicitly
  // to ensure children get processed through `next` consistently
  paragraph(node, next) {
    return {
      type: "paragraph",
      children: next(node.children),
    };
  },

  list(node, next) {
    const type = node.ordered ? "numbered-list" : "bulleted-list";
    return {
      type,
      children: next(node.children),
    };
  },

  listItem(node, next) {
    // remark wraps list item content in a paragraph — we need to flatten
    // so the frontend gets { type: "list-item", children: [{ text }] }
    const processed = next(node.children) as SlateNode[];
    // If the only child is a paragraph, unwrap its children
    const children =
      processed.length === 1 &&
      processed[0] &&
      (processed[0] as any).type === "paragraph"
        ? ((processed[0] as any).children as SlateNode[])
        : processed;
    return {
      type: "list-item",
      children,
    };
  },

  code(node) {
    // Fenced code blocks → code-block element
    return {
      type: "code-block",
      language: (node.lang as string) ?? "",
      children: [{ text: node.value as string }],
    };
  },

  blockquote(node, next) {
    // Frontend doesn't have a blockquote type — flatten to paragraphs
    // Each child (usually paragraphs) gets returned as-is
    const children = next(node.children) as SlateNode[];
    return children.length > 0 ? children : undefined;
  },

  thematicBreak() {
    // --- / *** → no frontend equivalent, skip
    return { type: "paragraph", children: [{ text: "---" }] };
  },

  // ── Inline elements ─────────────────────────────────────────────
  link(node, next) {
    return {
      type: "link",
      url: node.url as string,
      children: next(node.children),
    };
  },

  image(node) {
    return {
      type: "image",
      url: node.url as string,
      children: [{ text: (node.alt as string) ?? "" }],
    };
  },

  // ── Text marks ──────────────────────────────────────────────────
  // remark-slate-transformer applies these as flags on text nodes.
  // We need to remap the flag names to match the frontend's CustomText.

  strong(node, next) {
    // Apply bold: true to all text children
    const children = next(node.children) as SlateNode[];
    return children.map((child) => ({ ...child, bold: true }));
  },

  emphasis(node, next) {
    const children = next(node.children) as SlateNode[];
    return children.map((child) => ({ ...child, italic: true }));
  },

  delete(node, next) {
    const children = next(node.children) as SlateNode[];
    return children.map((child) => ({ ...child, strikethrough: "true" }));
  },

  inlineCode(node) {
    // Frontend has code-inline as an element type wrapping text
    return {
      type: "code-inline",
      children: [{ text: node.value as string }],
    };
  },
};

/** The default empty Slate document the frontend uses. */
const SLATE_DEFAULT = [{ type: "paragraph", children: [{ text: "" }] }];

/**
 * Unified processor configured with our overrides.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)  // GFM: ~~strikethrough~~, tables, autolinks, task lists
  .use(remarkToSlate, { overrides } as any);

/**
 * Convert a Markdown string to a Slate `SlateDescendant[]` array compatible
 * with the DeXe investing-dashboard frontend.
 *
 * - Empty / whitespace-only input → default empty paragraph node
 * - Plain text (no markdown syntax) → paragraph nodes split by newline
 * - Rich markdown → full Slate tree with headings, lists, bold, etc.
 *
 * This function is synchronous (`processSync`).
 */
export function markdownToSlate(markdown: string): unknown[] {
  if (!markdown || markdown.trim().length === 0) {
    return SLATE_DEFAULT;
  }

  try {
    const result = processor.processSync(markdown);
    const nodes = result.result as unknown[];

    if (!Array.isArray(nodes) || nodes.length === 0) {
      return SLATE_DEFAULT;
    }

    // Flatten any arrays returned by mark overrides (strong/emphasis/delete
    // return arrays of text nodes instead of a single element)
    return flattenSlateNodes(nodes);
  } catch {
    // Fallback: split by newlines into paragraphs (same as old behavior)
    const lines = markdown.split("\n").filter((l) => l.length > 0);
    return lines.length > 0
      ? lines.map((line) => ({ type: "paragraph", children: [{ text: line }] }))
      : SLATE_DEFAULT;
  }
}

/**
 * Recursively flatten any nested arrays that our mark overrides produce.
 * Mark handlers (strong, emphasis, delete) return arrays of text nodes
 * instead of elements, which can end up as nested arrays in children.
 */
function flattenSlateNodes(nodes: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const node of nodes) {
    if (Array.isArray(node)) {
      result.push(...flattenSlateNodes(node));
    } else if (node && typeof node === "object") {
      const n = node as Record<string, unknown>;
      if (Array.isArray(n.children)) {
        result.push({ ...n, children: flattenSlateNodes(n.children as unknown[]) });
      } else {
        result.push(n);
      }
    } else {
      result.push(node);
    }
  }
  return result;
}
