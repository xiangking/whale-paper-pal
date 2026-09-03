import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OutlineEntry, SearchHit } from "../types";

type PdfOutlineItem = {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
};

type PageLine = {
  text: string;
  y: number;
  height: number;
  right: number;
  fontName: string;
};

type DetectedHeading = {
  title: string;
  pageNumber: number;
  level: number;
};

const OUTLINE_SCAN_PAGE_LIMIT = 30;
const UNNUMBERED_HEADING_PATTERN = /^(?:abstract|summary|introduction|background|related work|methods?|methodology|materials and methods|experiments?|experimental setup|evaluation|results?|discussion|conclusions?|limitations?|future work|acknowledg(?:e)?ments?|references|bibliography)$/i;

function normalizeOutlineTitle(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function pageLines(items: PdfTextItem[]): PageLine[] {
  const lines: PageLine[] = [];
  items.forEach((item) => {
    const text = normalizeOutlineTitle(item.str);
    if (!text || item.transform.length < 6) return;
    const x = item.transform[4];
    const y = item.transform[5];
    const height = Math.max(Math.abs(item.height), Math.hypot(item.transform[2] || 0, item.transform[3] || 0), 1);
    const previous = lines.at(-1);
    const horizontalGap = previous ? x - previous.right : Number.POSITIVE_INFINITY;
    const sameLine = previous
      && Math.abs(previous.y - y) <= Math.max(1.5, Math.min(previous.height, height) * 0.3)
      && horizontalGap >= -2
      && horizontalGap <= Math.max(24, height * 3);
    if (sameLine) {
      previous.text = normalizeOutlineTitle(`${previous.text} ${text}`);
      previous.height = Math.max(previous.height, height);
      previous.right = Math.max(previous.right, x + Math.abs(item.width));
      return;
    }
    lines.push({ text, y, height, right: x + Math.abs(item.width), fontName: item.fontName });
  });
  return lines;
}

function estimateBodyTextHeight(lines: PageLine[]): number {
  const buckets = new Map<number, number>();
  lines.forEach((line) => {
    if (line.text.length < 40 || line.height < 5 || line.height > 24) return;
    const bucket = Math.round(line.height * 4) / 4;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  });
  return [...buckets].sort((left, right) => right[1] - left[1])[0]?.[0] || 9;
}

function identifyHeadingFonts(lines: PageLine[], bodyHeight: number): Set<string> {
  const fonts = new Set<string>();
  lines.forEach((line) => {
    const title = normalizeOutlineTitle(line.text);
    const numbered = /^(\d{1,2})(?:\.\d{1,2})*\.?\s+[\p{L}]/u.test(title);
    const lettered = /^[A-Z](?:\.\d{1,2})*\.?\s+[\p{L}]/u.test(title);
    if (UNNUMBERED_HEADING_PATTERN.test(title) || ((numbered || lettered) && line.height >= bodyHeight * 1.05)) {
      fonts.add(line.fontName);
    }
  });
  return fonts;
}

function headingLevel(title: string, line: PageLine, bodyHeight: number, headingFonts: Set<string>): number | undefined {
  if (line.height < bodyHeight * 0.94) return undefined;
  if (headingFonts.size && !headingFonts.has(line.fontName)) return undefined;
  const numbered = title.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([\p{L}].*)$/u);
  if (numbered) {
    const parts = numbered[1].split(".");
    if (Number(parts[0]) >= 1 && Number(parts[0]) <= 30 && !numbered[2].endsWith("-")) return parts.length - 1;
  }
  const lettered = title.match(/^([A-Z](?:\.\d{1,2}){0,3})\.?\s+([\p{L}].*)$/u);
  if (lettered && !lettered[2].endsWith("-") && !/[.!?]$/.test(title)) return lettered[1].split(".").length - 1;
  const appendix = /^(?:appendix|appendices)(?:\s+[A-Z0-9]+)?(?:\s*[:.-]\s*|\s+).+/i.test(title);
  if (appendix && !/[.!?]$/.test(title)) return 0;
  return UNNUMBERED_HEADING_PATTERN.test(title) ? 0 : undefined;
}

function buildDetectedOutline(headings: DetectedHeading[]): OutlineEntry[] {
  const roots: OutlineEntry[] = [];
  const stack: Array<{ level: number; entry: OutlineEntry }> = [];
  headings.forEach((heading) => {
    const entry: OutlineEntry = { title: heading.title, pageNumber: heading.pageNumber, items: [] };
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    if (stack.length) stack.at(-1)!.entry.items.push(entry);
    else roots.push(entry);
    stack.push({ level: heading.level, entry });
  });
  return roots.length === 1 && roots[0].items.length ? roots[0].items : roots;
}

async function detectOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const linesByPage: Array<{ pageNumber: number; lines: PageLine[] }> = [];
  const allLines: PageLine[] = [];
  const headings: DetectedHeading[] = [];
  const seen = new Set<string>();
  const pageLimit = Math.min(pdf.numPages, OUTLINE_SCAN_PAGE_LIMIT);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is typeof item & PdfTextItem => "str" in item && "transform" in item);
    const lines = pageLines(items);
    linesByPage.push({ pageNumber, lines });
    allLines.push(...lines);
  }
  const bodyHeight = estimateBodyTextHeight(allLines);
  const headingFonts = identifyHeadingFonts(allLines, bodyHeight);
  for (const { pageNumber, lines } of linesByPage) {
    for (const line of lines) {
      const title = normalizeOutlineTitle(line.text);
      if (title.length < 2 || title.length > 180) continue;
      const level = headingLevel(title, line, bodyHeight, headingFonts);
      if (level === undefined) continue;
      const identity = title.toLocaleLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      headings.push({ title, pageNumber, level });
    }
  }
  return buildDetectedOutline(headings);
}

export async function resolveOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const source = (await pdf.getOutline()) as PdfOutlineItem[] | null;
  if (!source?.length) return detectOutline(pdf);

  const resolveItem = async (item: PdfOutlineItem): Promise<OutlineEntry> => {
    let pageNumber: number | undefined;
    try {
      const destination = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
      if (destination?.[0]) {
        const pageIndex = await pdf.getPageIndex(destination[0]);
        pageNumber = pageIndex + 1;
      }
    } catch {
      pageNumber = undefined;
    }
    return {
      title: item.title,
      pageNumber,
      items: await Promise.all((item.items || []).map(resolveItem)),
    };
  };

  return Promise.all(source.map(resolveItem));
}

export async function buildTextIndex(
  pdf: PDFDocumentProxy,
  onProgress?: (completed: number) => void,
): Promise<string[]> {
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " "),
    );
    onProgress?.(pageNumber);
  }
  return pages;
}

export function searchTextIndex(index: string[], query: string): SearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return index.flatMap((text, pageIndex) => {
    const haystack = text.toLocaleLowerCase();
    let cursor = 0;
    let count = 0;
    let first = -1;
    while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
      if (first === -1) first = cursor;
      count += 1;
      cursor += Math.max(needle.length, 1);
    }
    if (!count) return [];
    const start = Math.max(0, first - 56);
    const end = Math.min(text.length, first + needle.length + 80);
    return [{ pageNumber: pageIndex + 1, count, excerpt: text.slice(start, end) }];
  });
}

export function escapeAndHighlight(text: string, query: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  const term = query.trim();
  if (!term) return escaped;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
}
